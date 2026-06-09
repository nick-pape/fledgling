import { describe, expect, it, vi } from "vitest";

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

  it("throws an actionable error when Web Crypto is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    vi.stubGlobal("crypto", undefined);

    try {
      expect(() => new MemorySessionManager().createSessionId()).toThrow(
        "Web Crypto is required to create ACP session IDs"
      );
    } finally {
      vi.unstubAllGlobals();
      if (descriptor) {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
    }
  });
});
