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
    this.#storage = options.storage ?? getDefaultStorage();
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

function getDefaultStorage(): Storage {
  try {
    const storage = (globalThis as { readonly localStorage?: Storage }).localStorage;
    if (storage !== undefined) {
      return storage;
    }
  } catch {
    // Fall through to the actionable error below.
  }

  throw new Error(
    "LocalStorageSessionManager requires browser localStorage; pass an explicit Storage implementation in restricted or non-window environments."
  );
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
