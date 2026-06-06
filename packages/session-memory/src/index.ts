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
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] % 16) + 64;
    bytes[8] = (bytes[8] % 64) + 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10, 16).join("")}`;
  }

  throw new Error("Web Crypto is required to create ACP session IDs");
}
