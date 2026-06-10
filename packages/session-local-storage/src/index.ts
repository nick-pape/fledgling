/**
 * Browser localStorage-backed session persistence for Fledgling.
 *
 * @packageDocumentation
 */

import type { ISessionManager, SessionEventBase } from "@fledgling/agent-core";
import type { SessionEvent } from "@fledgling/common";

/**
 * Options for configuring a {@link LocalStorageSessionManager}.
 *
 * @public
 */
export interface LocalStorageSessionManagerOptions {
  /**
   * Storage implementation used to persist session events.
   *
   * Defaults to `globalThis.localStorage`.
   */
  readonly storage?: Storage;

  /**
   * Prefix prepended to generated storage keys.
   *
   * Defaults to `fledgling:sessions:`.
   */
  readonly keyPrefix?: string;
}

/**
 * Stores and loads Fledgling session events from Web Storage.
 *
 * Each session is serialized as a JSON array under a key derived from the
 * configured key prefix and sanitized session ID.
 *
 * @public
 */
export class LocalStorageSessionManager implements ISessionManager {
  readonly #storage: Storage;
  readonly #keyPrefix: string;

  /**
   * Creates a localStorage-backed session manager.
   *
   * @param options - Optional storage implementation and key prefix overrides.
   */
  public constructor(options: LocalStorageSessionManagerOptions = {}) {
    this.#storage = options.storage ?? getDefaultStorage();
    this.#keyPrefix = options.keyPrefix ?? "fledgling:sessions:";
  }

  /**
   * Creates a new unique session identifier.
   *
   * @returns A UUID suitable for use as a Fledgling session ID.
   */
  public createSessionId(): string {
    return createId();
  }

  /**
   * Creates the common event fields for a session event.
   *
   * @param sessionId - Session identifier that the event belongs to.
   * @returns A base event object with a new event ID and timestamp.
   */
  public createEventBase(sessionId: string): SessionEventBase {
    return {
      eventId: createId(),
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Appends a session event to persistent storage.
   *
   * @param event - Session event to append.
   */
  public async appendEvent(event: SessionEvent): Promise<void> {
    const events = this.#loadExistingEvents(event.sessionId);
    events.push(event);
    this.#storage.setItem(this.#sessionKey(event.sessionId), JSON.stringify(events));
  }

  /**
   * Loads all stored events for a session.
   *
   * @param sessionId - Session identifier to load.
   * @returns Events read from Web Storage in insertion order.
   * @throws Error when the session is unknown or contains events for a
   * different session ID.
   */
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
  const crypto = (globalThis as { readonly crypto?: Crypto }).crypto;
  if (!crypto) {
    throw new Error("Web Crypto is required to create ACP session IDs");
  }

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
