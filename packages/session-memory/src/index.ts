/**
 * In-memory session persistence for Fledgling.
 *
 * @packageDocumentation
 */

import type { ISessionManager, SessionEventBase } from "@fledgling/agent-core";
import type { SessionEvent } from "@fledgling/common";

interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

/**
 * Stores and loads Fledgling session events in process memory.
 *
 * Events are grouped by session ID and are discarded when the manager instance
 * is discarded.
 *
 * @public
 */
export class MemorySessionManager implements ISessionManager {
  readonly #eventsBySessionId: Map<string, SessionEvent[]> = new Map();

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
   * Appends a session event to memory.
   *
   * @param event - Session event to append.
   */
  public async appendEvent(event: SessionEvent): Promise<void> {
    const events = this.#eventsBySessionId.get(event.sessionId) ?? [];
    events.push(event);
    this.#eventsBySessionId.set(event.sessionId, events);
  }

  /**
   * Loads all stored events for a session.
   *
   * @param sessionId - Session identifier to load.
   * @returns Events read from memory in insertion order.
   * @throws Error when the session is unknown.
   */
  public async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    const events = this.#eventsBySessionId.get(sessionId);
    if (!events) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }

    return [...events];
  }
}

function createId(): string {
  const crypto = (globalThis as { readonly crypto?: WebCryptoLike }).crypto;
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
