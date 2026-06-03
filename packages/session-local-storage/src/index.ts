import type { ISessionManager, SessionEventBase } from "@fledgling/agent-core";
import type { SessionEvent } from "@fledgling/common";

export interface LocalStorageSessionManagerOptions {
  readonly storage?: Storage;
  readonly keyPrefix?: string;
}

export class LocalStorageSessionManager implements ISessionManager {
  readonly #storage: Storage;
  readonly #keyPrefix: string;

  public constructor(options: LocalStorageSessionManagerOptions = {}) {
    this.#storage = options.storage ?? globalThis.localStorage;
    this.#keyPrefix = options.keyPrefix ?? "fledgling:sessions:";
  }

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
    const events = this.#loadExistingEvents(event.sessionId);
    events.push(event);
    this.#storage.setItem(this.#sessionKey(event.sessionId), JSON.stringify(events));
  }

  public async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const raw = this.#storage.getItem(this.#sessionKey(sessionId));
    if (!raw) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }

    const events = JSON.parse(raw) as SessionEvent[];
    if (events.some((event) => event.sessionId !== sessionId)) {
      throw new Error(`Stored ACP session contains events for another session: ${sessionId}`);
    }

    return events;
  }

  #loadExistingEvents(sessionId: string): SessionEvent[] {
    const raw = this.#storage.getItem(this.#sessionKey(sessionId));
    return raw ? (JSON.parse(raw) as SessionEvent[]) : [];
  }

  #sessionKey(sessionId: string): string {
    return `${this.#keyPrefix}${sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`;
  }
}

function createId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
