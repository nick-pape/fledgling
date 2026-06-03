import { describe, expect, it } from "vitest";

import { MemorySessionManager } from "./index.js";

describe("MemorySessionManager", () => {
  it("appends and loads session events", async () => {
    const manager = new MemorySessionManager();
    const sessionId = manager.createSessionId();
    const event = {
      ...manager.createEventBase(sessionId),
      type: "message.user",
      text: "hello"
    } as const;

    await manager.appendEvent(event);

    await expect(manager.loadEvents(sessionId)).resolves.toEqual([event]);
  });

  it("rejects unknown sessions", async () => {
    const manager = new MemorySessionManager();

    await expect(manager.loadEvents("missing")).rejects.toThrow("Unknown ACP session: missing");
  });
});
