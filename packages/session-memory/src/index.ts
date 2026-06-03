import type { ISessionManager, SessionEventBase } from "@fledgling/agent-core";
import type { SessionEvent } from "@fledgling/common";

export class MemorySessionManager implements ISessionManager {
  readonly #eventsBySessionId: Map<string, SessionEvent[]> = new Map();

  public createSessionId(): string {
    return createId();
  }

  public createEventBase(sessionId: string): SessionEventBase {
    return {
      eventId: createId(),
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  public async appendEvent(event: SessionEvent): Promise<void> {
    const events = this.#eventsBySessionId.get(event.sessionId) ?? [];
    events.push(event);
    this.#eventsBySessionId.set(event.sessionId, events);
  }

  public async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const events = this.#eventsBySessionId.get(sessionId);
    if (!events) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }

    return [...events];
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
