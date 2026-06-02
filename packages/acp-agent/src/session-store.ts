import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SessionEvent } from "@fledgling/common";

export class SessionStore {
  readonly #root: string;
  readonly #sessionFile: string | undefined;

  public constructor(root: string = defaultSessionStoreRoot(), sessionFile: string | undefined = process.env.FLEDGLING_SESSION_FILE) {
    this.#root = root;
    this.#sessionFile = sessionFile ? path.resolve(sessionFile) : undefined;
  }

  public createId(): string {
    return randomUUID();
  }

  public createEventBase(sessionId: string): Pick<SessionEvent, "eventId" | "sessionId" | "timestamp"> {
    return {
      eventId: randomUUID(),
      sessionId,
      timestamp: new Date().toISOString()
    };
  }

  public async append(event: SessionEvent): Promise<void> {
    const sessionPath = this.#sessionPath(event.sessionId);
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await appendFile(sessionPath, `${JSON.stringify(event)}\n`, "utf8");
  }

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

export function defaultSessionStoreRoot(): string {
  return path.resolve(process.env.FLEDGLING_SESSION_DIR ?? path.join(process.cwd(), ".fledgling", "sessions"));
}

function sessionIdToFileName(sessionId: string): string {
  return sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}
