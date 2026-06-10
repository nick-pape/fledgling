import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SessionEvent } from "@fledgling/common";

/**
 * Stores and loads session events as newline-delimited JSON files.
 */
export class SessionStore {
  readonly #root: string;
  readonly #sessionFile: string | undefined;

  /**
   * Creates a session store rooted at the provided directory.
   *
   * @param root - Directory used for per-session log files when no explicit session file is provided.
   * @param sessionFile - Optional log file path that stores every session in one portable JSONL file.
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
   */
  public createId(): string {
    return randomUUID();
  }

  /**
   * Creates the common event fields for a session event.
   *
   * @param sessionId - Session identifier to include in the event base.
   */
  public createEventBase(sessionId: string): Pick<SessionEvent, "eventId" | "sessionId" | "timestamp"> {
    return {
      eventId: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Appends an event to its session log.
   *
   * @param event - Session event to serialize as a JSONL entry.
   */
  public async append(event: SessionEvent): Promise<void> {
    const sessionPath = this.#sessionPath(event.sessionId);
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await appendFile(sessionPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  /**
   * Loads all events for a session.
   *
   * @param sessionId - Session identifier to read.
   * @throws Error if the session log cannot be read or contains events for another session.
   */
  public async load(sessionId: string): Promise<SessionEvent[]> {
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
 * Returns the default directory for session log files.
 *
 * The `FLEDGLING_SESSION_DIR` environment variable overrides the workspace-local default.
 */
export function defaultSessionStoreRoot(): string {
  return path.resolve(process.env.FLEDGLING_SESSION_DIR ?? path.join(process.cwd(), ".fledgling", "sessions"));
}

function sessionIdToFileName(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}
