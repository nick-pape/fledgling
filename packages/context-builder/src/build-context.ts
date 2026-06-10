import type { ContextMessage, SessionEvent } from "@fledgling/common";

import { pruneOldVolatileEvents, type DroppedEvent, type PruneEventsOptions } from "./prune-events.js";
import { estimateEventTokens, estimateMessagesTokens } from "./token-estimator.js";

/**
 * Options for building context directly from replayable events.
 */
export interface BuildReplayContextOptions {
  /**
   * Selects replay mode, which preserves events without compaction.
   */
  readonly mode: "replay";
}

/**
 * Model-ready context derived from session events.
 */
export interface BuiltContext {
  /**
   * Messages ready to send to a chat-style model.
   */
  readonly messages: ContextMessage[];

  /**
   * Session events retained in the context.
   */
  readonly events: SessionEvent[];

  /**
   * Events removed while preparing the context.
   */
  readonly dropped: DroppedEvent[];

  /**
   * Estimated token count for the generated messages.
   */
  readonly tokenEstimate: number;
}

/**
 * Options for selecting which events should be compacted.
 */
export interface PrepareCompactionOptions {
  /**
   * Number of latest user turns to retain verbatim.
   */
  readonly keepLatestTurns: number;

  /**
   * Optional pruning settings applied before compaction selection.
   */
  readonly prune?: PruneEventsOptions;

  /**
   * Maximum estimated tokens to pass into the compaction model.
   */
  readonly maxCompactionInputTokens?: number;
}

/**
 * Partitioned events and estimates prepared for compaction.
 */
export interface PreparedCompaction {
  /**
   * Older events selected as compaction model input.
   */
  readonly eventsToCompact: SessionEvent[];

  /**
   * Recent events retained verbatim after compaction.
   */
  readonly retainedEvents: SessionEvent[];

  /**
   * Events dropped during pruning or input limiting.
   */
  readonly dropped: DroppedEvent[];

  /**
   * Estimated token count for events selected as compaction input.
   */
  readonly compactionInputTokenEstimate: number;

  /**
   * Estimated token count for retained events after conversion to messages.
   */
  readonly retainedTokenEstimate: number;

  /**
   * Whether any events remain to compact.
   */
  readonly needsCompaction: boolean;
}

/**
 * Options for constructing context from an existing compaction summary.
 */
export interface BuildCompactedContextOptions {
  /**
   * Continuity summary to prepend as a system message.
   */
  readonly summary: string;

  /**
   * Recent events to retain after the summary.
   */
  readonly retainedEvents: readonly SessionEvent[];
}

/**
 * Request passed to a compaction model.
 */
export interface CompactionModelRequest {
  /**
   * Events that should be summarized.
   */
  readonly events: SessionEvent[];

  /**
   * Desired token budget for the summary, when provided.
   */
  readonly targetTokens: number | undefined;

  /**
   * Instructions for producing the continuity summary.
   */
  readonly instructions: string;

  /**
   * Estimated token count for the input events.
   */
  readonly inputTokenEstimate: number;
}

/**
 * Result returned by a compaction model.
 */
export interface CompactionModelResult {
  /**
   * Continuity summary of the compacted events.
   */
  readonly summary: string;

  /**
   * Estimated token count for the summary, when known.
   */
  readonly tokenEstimate?: number;
}

/**
 * Function that summarizes older session events for compaction.
 */
export type CompactionFunction = (request: CompactionModelRequest) => Promise<CompactionModelResult>;

/**
 * Options for preparing and compacting a session event stream.
 */
export interface CompactContextOptions extends PrepareCompactionOptions {
  /**
   * Desired token budget for the generated summary.
   */
  readonly targetTokens?: number;

  /**
   * Custom instructions for the compaction model.
   */
  readonly instructions?: string;

  /**
   * Function used to generate the compaction summary.
   */
  readonly compact: CompactionFunction;
}

/**
 * Context result produced by a compaction pass.
 */
export interface CompactedContextResult extends BuiltContext {
  /**
   * Preparation details used to decide what was compacted.
   */
  readonly prepared: PreparedCompaction;

  /**
   * Generated summary, or undefined when compaction was unnecessary.
   */
  readonly summary: string | undefined;
}

/**
 * Default instructions for preserving coding-session continuity during compaction.
 */
export const DEFAULT_COMPACTION_INSTRUCTIONS: string =
  "Write a detailed continuity summary for resuming a coding-agent session. Preserve user goals, decisions, constraints, rejected approaches, files or modules discussed, pending work, and historical observations that may need refresh. Do not treat old command output, file contents, git status, test results, or directory listings as current truth.";

/**
 * Builds replay context by converting message events to model messages.
 */
export function buildContext(events: readonly SessionEvent[], _options: BuildReplayContextOptions): BuiltContext {
  const messages = eventsToMessages(events);
  return {
    messages,
    events: [...events],
    dropped: [],
    tokenEstimate: estimateMessagesTokens(messages)
  };
}

/**
 * Builds context, compacting older events into a summary when needed.
 */
export async function compactContext(
  events: readonly SessionEvent[],
  options: CompactContextOptions
): Promise<CompactedContextResult> {
  const prepared = prepareCompaction(events, options);

  if (!prepared.needsCompaction) {
    const context = buildContext(prepared.retainedEvents, { mode: "replay" });
    return {
      ...context,
      dropped: prepared.dropped,
      prepared,
      summary: undefined
    };
  }

  const result = await options.compact({
    events: prepared.eventsToCompact,
    targetTokens: options.targetTokens,
    instructions: options.instructions ?? DEFAULT_COMPACTION_INSTRUCTIONS,
    inputTokenEstimate: prepared.compactionInputTokenEstimate
  });
  const context = buildCompactedContext({
    summary: result.summary,
    retainedEvents: prepared.retainedEvents
  });

  return {
    ...context,
    dropped: prepared.dropped,
    prepared,
    summary: result.summary
  };
}

/**
 * Prunes volatile events and splits older events from the latest retained turns.
 */
export function prepareCompaction(
  events: readonly SessionEvent[],
  options: PrepareCompactionOptions
): PreparedCompaction {
  const pruned = pruneOldVolatileEvents(events, options.prune);
  const split = splitLatestTurns(pruned.events, options.keepLatestTurns);
  const limited = limitCompactionInput(split.eventsToCompact, options.maxCompactionInputTokens);

  return {
    eventsToCompact: limited.events,
    retainedEvents: split.retainedEvents,
    dropped: [...pruned.dropped, ...limited.dropped],
    compactionInputTokenEstimate: estimateEventsTokens(limited.events),
    retainedTokenEstimate: estimateMessagesTokens(eventsToMessages(split.retainedEvents)),
    needsCompaction: limited.events.length > 0
  };
}

/**
 * Builds context from a compaction summary plus retained events.
 */
export function buildCompactedContext(options: BuildCompactedContextOptions): BuiltContext {
  const retainedMessages = eventsToMessages(options.retainedEvents);
  const messages: ContextMessage[] = [
    {
      role: "system",
      content: options.summary
    },
    ...retainedMessages
  ];

  return {
    messages,
    events: [...options.retainedEvents],
    dropped: [],
    tokenEstimate: estimateMessagesTokens(messages)
  };
}

/**
 * Converts user and assistant message events into chat messages.
 */
export function eventsToMessages(events: readonly SessionEvent[]): ContextMessage[] {
  const messages: ContextMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case "message.user":
        messages.push({ role: "user", content: event.text });
        break;

      case "message.assistant":
        messages.push({ role: "assistant", content: event.text });
        break;
    }
  }

  return messages;
}

function splitLatestTurns(
  events: readonly SessionEvent[],
  keepLatestTurns: number
): { eventsToCompact: SessionEvent[]; retainedEvents: SessionEvent[] } {
  if (keepLatestTurns <= 0) {
    return {
      eventsToCompact: [...events],
      retainedEvents: []
    };
  }

  let userTurnsSeen = 0;
  let retainedStart = events.length;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "message.user") {
      userTurnsSeen++;
      if (userTurnsSeen === keepLatestTurns) {
        retainedStart = index;
        break;
      }
    }
  }

  if (userTurnsSeen < keepLatestTurns) {
    retainedStart = 0;
  }

  return {
    eventsToCompact: events.slice(0, retainedStart),
    retainedEvents: events.slice(retainedStart)
  };
}

function limitCompactionInput(
  events: readonly SessionEvent[],
  maxTokens: number | undefined
): { events: SessionEvent[]; dropped: DroppedEvent[] } {
  if (maxTokens === undefined) {
    return { events: [...events], dropped: [] };
  }

  const retained: SessionEvent[] = [];
  const dropped: DroppedEvent[] = [];
  let tokenEstimate = 0;

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const eventTokens = estimateEventTokens(event);
    if (tokenEstimate + eventTokens <= maxTokens) {
      retained.unshift(event);
      tokenEstimate += eventTokens;
      continue;
    }

    dropped.unshift({
      eventId: event.eventId,
      type: event.type,
      reason: "compaction_input_over_token_budget"
    });
  }

  return { events: retained, dropped };
}

function estimateEventsTokens(events: readonly SessionEvent[]): number {
  return events.reduce((total, event) => total + estimateEventTokens(event), 0);
}
