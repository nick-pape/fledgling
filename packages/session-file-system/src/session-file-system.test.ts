import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemSessionManager } from "./index.js";

let tempDir: string | undefined;

describe("FileSystemSessionManager", () => {
  afterEach(async () => {
    const cleanupDir = tempDir;
    tempDir = undefined;
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  });

  it("appends and loads JSONL session events", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-session-file-system-test-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const manager = new FileSystemSessionManager(tempDir, sessionFile);
    const sessionId = manager.createSessionId();
    const event = {
      ...manager.createEventBase(sessionId),
      type: "message.user",
      text: "hello"
    } as const;

    await manager.appendEvent(event);

    await expect(manager.loadEvents(sessionId)).resolves.toEqual([event]);
    expect(await readFile(sessionFile, "utf8")).toContain('"type":"message.user"');
  });

  it("rejects unknown sessions", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-session-file-system-test-"));
    const manager = new FileSystemSessionManager(tempDir);

    await expect(manager.loadEvents("missing")).rejects.toThrow("Unknown ACP session: missing");
  });
});
