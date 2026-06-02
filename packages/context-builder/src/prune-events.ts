import type { SessionEvent, ToolCallEvent, ToolResultEvent } from "@fledgling/common";

export interface PruneEventsOptions {
  readonly keepLatestToolResultsPerGroup?: number;
  readonly keepLatestToolCallsPerGroup?: number;
}

export interface PrunedEvents {
  readonly events: SessionEvent[];
  readonly dropped: DroppedEvent[];
}

export interface DroppedEvent {
  readonly eventId: string;
  readonly type: SessionEvent["type"];
  readonly reason: string;
}

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
