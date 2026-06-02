import type { ContextMessage, SessionEvent } from "@fledgling/common";

import { pruneOldVolatileEvents, type DroppedEvent, type PruneEventsOptions } from "./prune-events.js";
import { estimateEventTokens, estimateMessagesTokens } from "./token-estimator.js";

export interface BuildReplayContextOptions {
  readonly mode: "replay";
}

export interface BuiltContext {
  readonly messages: ContextMessage[];
  readonly events: SessionEvent[];
  readonly dropped: DroppedEvent[];
  readonly tokenEstimate: number;
}

export interface PrepareCompactionOptions {
  readonly keepLatestTurns: number;
  readonly prune?: PruneEventsOptions;
  readonly maxCompactionInputTokens?: number;
}

export interface PreparedCompaction {
  readonly eventsToCompact: SessionEvent[];
  readonly retainedEvents: SessionEvent[];
  readonly dropped: DroppedEvent[];
  readonly compactionInputTokenEstimate: number;
  readonly retainedTokenEstimate: number;
  readonly needsCompaction: boolean;
}

export interface BuildCompactedContextOptions {
  readonly summary: string;
  readonly retainedEvents: readonly SessionEvent[];
}

export interface CompactionModelRequest {
  readonly events: SessionEvent[];
  readonly targetTokens: number | undefined;
  readonly instructions: string;
  readonly inputTokenEstimate: number;
}

export interface CompactionModelResult {
  readonly summary: string;
  readonly tokenEstimate?: number;
}

export type CompactionFunction = (request: CompactionModelRequest) => Promise<CompactionModelResult>;

export interface CompactContextOptions extends PrepareCompactionOptions {
  readonly targetTokens?: number;
  readonly instructions?: string;
  readonly compact: CompactionFunction;
}

export interface CompactedContextResult extends BuiltContext {
  readonly prepared: PreparedCompaction;
  readonly summary: string | undefined;
}

export const DEFAULT_COMPACTION_INSTRUCTIONS: string =
  "Write a detailed continuity summary for resuming a coding-agent session. Preserve user goals, decisions, constraints, rejected approaches, files or modules discussed, pending work, and historical observations that may need refresh. Do not treat old command output, file contents, git status, test results, or directory listings as current truth.";

export function buildContext(events: readonly SessionEvent[], _options: BuildReplayContextOptions): BuiltContext {
  const messages = eventsToMessages(events);
  return {
    messages,
    events: [...events],
    dropped: [],
    tokenEstimate: estimateMessagesTokens(messages)
  };
}

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
