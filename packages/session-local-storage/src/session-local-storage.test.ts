import { describe, expect, it, vi } from "vitest";

import { LocalStorageSessionManager } from "./index.js";

class MemoryStorage implements Storage {
  readonly #items: Map<string, string> = new Map();

  public get length(): number {
    return this.#items.size;
  }

  public clear(): void {
    this.#items.clear();
  }

  // eslint-disable-next-line @rushstack/no-new-null -- Storage.getItem is a DOM API.
  public getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  // eslint-disable-next-line @rushstack/no-new-null -- Storage.key is a DOM API.
  public key(index: number): string | null {
    return this.keys()[index] ?? null;
  }

  public removeItem(key: string): void {
    this.#items.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  public keys(): string[] {
    return [...this.#items.keys()];
  }
}

describe("LocalStorageSessionManager", () => {
  it("appends and loads session events with key prefix isolation", async () => {
    const storage = new MemoryStorage();
    const manager = new LocalStorageSessionManager({ storage, keyPrefix: "test:" });
    const sessionId = manager.createSessionId();
    const event = {
      ...manager.createEventBase(sessionId),
      type: "message.user",
      text: "hello"
    } as const;

    await manager.appendEvent(event);

    await expect(manager.loadEvents(sessionId)).resolves.toEqual([event]);
    expect(storage.keys()).toEqual([`test:${sessionId}`]);
  });

  it("rejects unknown sessions", async () => {
    const manager = new LocalStorageSessionManager({ storage: new MemoryStorage() });

    await expect(manager.loadEvents("missing")).rejects.toThrow("Unknown ACP session: missing");
  });

  it("throws an actionable error when default localStorage is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    vi.stubGlobal("localStorage", undefined);

    try {
      expect(() => new LocalStorageSessionManager()).toThrow(
        "LocalStorageSessionManager requires browser localStorage"
      );
    } finally {
      vi.unstubAllGlobals();
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });

  it("throws an actionable error when Web Crypto is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    vi.stubGlobal("crypto", undefined);

    try {
      expect(() =>
        new LocalStorageSessionManager({ storage: new MemoryStorage() }).createSessionId()
      ).toThrow("Web Crypto is required to create ACP session IDs");
    } finally {
      vi.unstubAllGlobals();
      if (descriptor) {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
    }
  });
});
