#!/usr/bin/env node
import assert from "node:assert/strict";

import { SessionCleanup, serializeError } from "../lib/session-cleanup.js";

const aborted = [];
const closeCalls = [];
const warnings = [];
let sessions = [
  {
    id: "session-a",
    pendingPrompt: {
      abort() {
        aborted.push("session-a");
      }
    },
    mcpClients: [
      {
        async close() {
          closeCalls.push("a-1");
        }
      },
      {
        async close() {
          closeCalls.push("a-2");
          throw new Error("close failed");
        }
      }
    ]
  },
  {
    id: "session-b",
    pendingPrompt: undefined,
    mcpClients: [
      {
        async close() {
          closeCalls.push("b-1");
        }
      }
    ]
  }
];

const cleanup = new SessionCleanup(
  () => sessions,
  () => {
    sessions = [];
  },
  (record) => warnings.push(record)
);

await cleanup.closeAll("test-shutdown");
await cleanup.closeAll("test-shutdown-again");

assert.deepEqual(aborted, ["session-a"]);
assert.deepEqual(closeCalls.sort(), ["a-1", "a-2", "b-1"]);
assert.deepEqual(sessions, []);
assert.deepEqual(warnings, [
  {
    level: "warn",
    event: "mcp_close_failed",
    sessionId: "session-a",
    reason: "test-shutdown",
    error: "close failed"
  }
]);

assert.equal(serializeError("plain"), "plain");
assert.equal(serializeError(undefined), "undefined");

console.log("session-cleanup ok");
