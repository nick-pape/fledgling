#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SessionStore } from "../lib/session-store.js";

const root = await mkdtemp(join(tmpdir(), "fledgling-session-store-"));

try {
  const store = new SessionStore(root);
  const sessionId = store.createId();
  const created = {
    ...store.createEventBase(sessionId),
    type: "session.created",
    cwd: "C:\\workspace",
    mcpServers: []
  };
  const user = {
    ...store.createEventBase(sessionId),
    type: "message.user",
    text: "remember alpha"
  };

  await store.append(created);
  await store.append(user);

  assert.deepEqual(await store.load(sessionId), [created, user]);
  await assert.rejects(() => store.load("missing-session"), /Unknown ACP session: missing-session/);

  const explicitFile = join(root, "portable.jsonl");
  const explicitStore = new SessionStore(root, explicitFile);
  await explicitStore.append(user);
  assert.deepEqual(await explicitStore.load(sessionId), [user]);
  assert.equal((await readFile(explicitFile, "utf8")).trim(), JSON.stringify(user));

  console.log("session-store ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
