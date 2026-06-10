import type { SessionEvent, ToolCallEvent, ToolResultEvent } from "@fledgling/common";

/**
 * Options for pruning older volatile tool events.
 */
export interface PruneEventsOptions {
  /**
   * Number of latest tool results to keep for each result group.
   */
  readonly keepLatestToolResultsPerGroup?: number;

  /**
   * Number of latest tool calls to keep for each tool name.
   */
  readonly keepLatestToolCallsPerGroup?: number;
}

/**
 * Events retained after pruning, plus records for removed events.
 */
export interface PrunedEvents {
  /**
   * Events retained in their original order.
   */
  readonly events: SessionEvent[];

  /**
   * Events removed by pruning.
   */
  readonly dropped: DroppedEvent[];
}

/**
 * Description of an event removed from context.
 */
export interface DroppedEvent {
  /**
   * Identifier of the removed event.
   */
  readonly eventId: string;

  /**
   * Type of the removed event.
   */
  readonly type: SessionEvent["type"];

  /**
   * Machine-readable reason the event was removed.
   */
  readonly reason: string;
}

/**
 * Removes older volatile tool calls and results while preserving recent entries per group.
 */
export function pruneOldVolatileEvents(
  events: readonly SessionEvent[],
  options: PruneEventsOptions = {}
): PrunedEvents {
  const keepLatestToolResultsPerGroup = options.keepLatestToolResultsPerGroup ?? 1;
  const keepLatestToolCallsPerGroup = options.keepLatestToolCallsPerGroup ?? 5;
  const keep = new Set<string>();

  markLatest(events, isToolResultEvent, toolResultGroupKey, keepLatestToolResultsPerGroup, keep);
  markLatest(events, isToolCallEvent, toolCallGroupKey, keepLatestToolCallsPerGroup, keep);

  const dropped: DroppedEvent[] = [];
  const pruned = events.filter((event) => {
    if (!isVolatileEvent(event)) {
      return true;
    }

    if (keep.has(event.eventId)) {
      return true;
    }

    dropped.push({
      eventId: event.eventId,
      type: event.type,
      reason: "old_volatile_event"
    });
    return false;
  });

  return { events: pruned, dropped };
}

function markLatest<TEvent extends SessionEvent>(
  events: readonly SessionEvent[],
  predicate: (event: SessionEvent) => event is TEvent,
  groupKey: (event: TEvent) => string,
  keepLatest: number,
  keep: Set<string>
): void {
  if (keepLatest <= 0) {
    return;
  }

  const counts = new Map<string, number>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!predicate(event)) {
      continue;
    }

    const key = groupKey(event);
    const count = counts.get(key) ?? 0;
    if (count < keepLatest) {
      keep.add(event.eventId);
    }

    counts.set(key, count + 1);
  }
}

function isVolatileEvent(event: SessionEvent): event is ToolCallEvent | ToolResultEvent {
  return isToolCallEvent(event) || isToolResultEvent(event);
}

function isToolCallEvent(event: SessionEvent): event is ToolCallEvent {
  return event.type === "tool.call";
}

function isToolResultEvent(event: SessionEvent): event is ToolResultEvent {
  return event.type === "tool.result";
}

function toolCallGroupKey(event: ToolCallEvent): string {
  return event.toolName;
}

function toolResultGroupKey(event: ToolResultEvent): string {
  return `${event.toolName ?? "unknown"}:${extractStableSubject(event)}`;
}

function extractStableSubject(event: ToolResultEvent): string {
  if (event.rawOutput && typeof event.rawOutput === "object" && "structuredContent" in event.rawOutput) {
    const structuredContent = (event.rawOutput as { readonly structuredContent?: unknown }).structuredContent;
    if (structuredContent && typeof structuredContent === "object" && "path" in structuredContent) {
      const path = (structuredContent as { readonly path?: unknown }).path;
      if (typeof path === "string") {
        return path;
      }
    }
  }

  return event.toolCallId;
}
