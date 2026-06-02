import { afterEach, describe, expect, it, vi } from "vitest";

describe("createSessionTools", () => {
  afterEach(() => {
    vi.doUnmock("@ai-sdk/mcp");
    vi.doUnmock("@ai-sdk/mcp/mcp-stdio");
    vi.resetModules();
  });

  it("closes created MCP clients when setup fails", async () => {
    const firstClient = {
      close: vi.fn<() => Promise<void>>(async () => {}),
      tools: vi.fn(async () => ({ first_tool: {} }))
    };
    const secondClient = {
      close: vi.fn<() => Promise<void>>(async () => {}),
      tools: vi.fn(async () => {
        throw new Error("tools failed");
      })
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

    const { createSessionTools } = await import("./mcp-session-tools.js");

    await expect(
      createSessionTools(undefined, [
        { name: "first", command: "first-command", args: [], env: [] },
        { name: "second", command: "second-command", args: [], env: [] }
      ])
    ).rejects.toThrow("tools failed");

    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).toHaveBeenCalledOnce();
  });
});
