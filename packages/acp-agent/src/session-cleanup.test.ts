import { describe, expect, it } from "vitest";

import { SessionCleanup, serializeError, type McpCloseFailureRecord, type SessionCleanupState } from "./session-cleanup.js";

describe("SessionCleanup", () => {
  it("aborts pending prompts, closes clients, logs close failures, and is idempotent", async () => {
    const aborted: string[] = [];
    const closeCalls: string[] = [];
    const warnings: McpCloseFailureRecord[] = [];
    let sessions: SessionCleanupState[] = [
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

    expect(aborted).toEqual(["session-a"]);
    expect(closeCalls.sort()).toEqual(["a-1", "a-2", "b-1"]);
    expect(sessions).toEqual([]);
    expect(warnings).toEqual([
      {
        level: "warn",
        event: "mcp_close_failed",
        sessionId: "session-a",
        reason: "test-shutdown",
        error: "close failed"
      }
    ]);
  });

  it("serializes unknown errors safely", () => {
    expect(serializeError("plain")).toBe("plain");
    expect(serializeError(undefined)).toBe("undefined");
  });
});
