import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "./session-store.js";

describe("SessionStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fledgling-session-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends and loads JSONL session events", async () => {
    const store = new SessionStore(root);
    const sessionId = store.createId();
    const created = {
      ...store.createEventBase(sessionId),
      type: "session.created" as const,
      cwd: "C:\\workspace",
      mcpServers: []
    };
    const user = {
      ...store.createEventBase(sessionId),
      type: "message.user" as const,
      text: "remember alpha"
    };

    await store.append(created);
    await store.append(user);

    expect(await store.load(sessionId)).toEqual([created, user]);
    await expect(() => store.load("missing-session")).rejects.toThrow(/Unknown ACP session: missing-session/);
  });

  it("can use an explicit portable session file", async () => {
    const sessionId = "portable-session";
    const explicitFile = join(root, "portable.jsonl");
    const explicitStore = new SessionStore(root, explicitFile);
    const user = {
      ...explicitStore.createEventBase(sessionId),
      type: "message.user" as const,
      text: "remember alpha"
    };

    await explicitStore.append(user);

    expect(await explicitStore.load(sessionId)).toEqual([user]);
    expect((await readFile(explicitFile, "utf8")).trim()).toBe(JSON.stringify(user));
  });
});
