import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("FledglingAgent session lifecycle", () => {
  const originalConfig = process.env.FLEDGLING_CONFIG;
  const originalSessionFile = process.env.FLEDGLING_SESSION_FILE;
  let tempDir: string | undefined;

  afterEach(async () => {
    restoreEnv("FLEDGLING_CONFIG", originalConfig);
    restoreEnv("FLEDGLING_SESSION_FILE", originalSessionFile);
    vi.doUnmock("@ai-sdk/mcp");
    vi.doUnmock("@ai-sdk/mcp/mcp-stdio");
    vi.resetModules();

    const cleanupDir = tempDir;
    tempDir = undefined;
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  });

  it("closes an existing session before replacing it during loadSession", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-agent-test-"));
    process.env.FLEDGLING_CONFIG = path.join(tempDir, "missing-config.json");
    process.env.FLEDGLING_SESSION_FILE = path.join(tempDir, "session.jsonl");

    const firstClient = {
      close: vi.fn<() => Promise<void>>(async () => {}),
      tools: vi.fn(async () => ({}))
    };
    const secondClient = {
      close: vi.fn<() => Promise<void>>(async () => {}),
      tools: vi.fn(async () => ({}))
    };
    const clients = [firstClient, secondClient];

    vi.doMock("@ai-sdk/mcp", () => ({
      experimental_createMCPClient: vi.fn(async () => {
        const client = clients.shift();
        if (!client) {
          throw new Error("unexpected client request");
        }

        return client;
      })
    }));
    vi.doMock("@ai-sdk/mcp/mcp-stdio", () => ({
      Experimental_StdioMCPTransport: class Experimental_StdioMCPTransport {
        public constructor(_options: unknown) {}
      }
    }));

    const { FledglingAgent } = await import("./agent.js");
    const agent = new FledglingAgent({
      sessionUpdate: vi.fn(async () => {})
    } as never);
    const mcpServers = [{ name: "workspace", command: "workspace-command", args: [], env: [] }];

    const session = await agent.newSession({ cwd: tempDir, mcpServers });
    await agent.loadSession({ sessionId: session.sessionId, cwd: tempDir, mcpServers });

    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
