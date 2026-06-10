/**
 * Filesystem-backed session persistence for Fledgling.
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ISessionManager, SessionEventBase } from "@fledgling/agent-core";
import type { SessionEvent } from "@fledgling/common";

/**
 * Stores and loads Fledgling session events as newline-delimited JSON files.
 *
 * Each session normally maps to a separate `.jsonl` file under the configured
 * root directory. A single explicit session file can also be supplied for
 * integrations that want all operations to target one known file path.
 *
 * @public
 */
export class FileSystemSessionManager implements ISessionManager {
  readonly #root: string;
  readonly #sessionFile: string | undefined;

  /**
   * Creates a filesystem-backed session manager.
   *
   * @param root - Directory used for per-session JSONL files when `sessionFile`
   * is not provided.
   * @param sessionFile - Optional path to a specific JSONL file. Defaults to
   * the `FLEDGLING_SESSION_FILE` environment variable when it is set.
   */
  public constructor(
    root: string = defaultSessionStoreRoot(),
    sessionFile: string | undefined = process.env.FLEDGLING_SESSION_FILE
  ) {
    this.#root = root;
    this.#sessionFile = sessionFile ? path.resolve(sessionFile) : undefined;
  }

  /**
   * Creates a new unique session identifier.
   *
   * @returns A UUID suitable for use as a Fledgling session ID.
   */
  public createSessionId(): string {
    return randomUUID();
  }

  /**
   * Creates the common event fields for a session event.
   *
   * @param sessionId - Session identifier that the event belongs to.
   * @returns A base event object with a new event ID and timestamp.
   */
  public createEventBase(sessionId: string): SessionEventBase {
    return {
      eventId: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Appends a session event to persistent storage.
   *
   * The event is serialized as one JSON line. Missing parent directories are
   * created before writing.
   *
   * @param event - Session event to append.
   */
  public async appendEvent(event: SessionEvent): Promise<void> {
    const sessionPath = this.#sessionPath(event.sessionId);
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await appendFile(sessionPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  /**
   * Loads all stored events for a session.
   *
   * @param sessionId - Session identifier to load.
   * @returns Events read from the session JSONL file in storage order.
   * @throws Error when the session file cannot be read or contains events for a
   * different session ID.
   */
  public async loadEvents(sessionId: string): Promise<SessionEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.#sessionPath(sessionId), "utf8");
    } catch (error: unknown) {
      throw new Error(`Unknown ACP session: ${sessionId}`, { cause: error });
    }

    const events = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SessionEvent);

    if (events.some((event) => event.sessionId !== sessionId)) {
      throw new Error(`Stored ACP session contains events for another session: ${sessionId}`);
    }

    return events;
  }

  #sessionPath(sessionId: string): string {
    if (this.#sessionFile) {
      return this.#sessionFile;
    }

    return path.join(this.#root, `${sessionIdToFileName(sessionId)}.jsonl`);
  }
}

/**
 * Resolves the default directory for filesystem session storage.
 *
 * @returns The absolute path from `FLEDGLING_SESSION_DIR`, or
 * `.fledgling/sessions` under the current working directory when the environment
 * variable is unset.
 *
 * @public
 */
export function defaultSessionStoreRoot(): string {
  return path.resolve(process.env.FLEDGLING_SESSION_DIR ?? path.join(process.cwd(), ".fledgling", "sessions"));
}

function sessionIdToFileName(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}
