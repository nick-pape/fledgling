import type { IModelTurnRunner, ModelTurnRequest } from "@fledgling/agent-core";
import { describe, expect, it, vi } from "vitest";

import type { IWorkspaceRuntime } from "@fledgling/mcp-workspace-webcontainer";

import { createWebAgent } from "./index.js";

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
    return [...this.#items.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.#items.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

describe("createWebAgent", () => {
  it("runs initialize, newSession, and prompt through the browser entrypoint", async () => {
    const sessionUpdates: unknown[] = [];
    const runModelTurn = vi.fn<IModelTurnRunner["runModelTurn"]>(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "pong" } as const;
      })()
    }));
    const agent = createWebAgent(
      {
        async sessionUpdate(params: unknown): Promise<void> {
          sessionUpdates.push(params);
        }
      } as never,
      {
        workspaceRuntime: createFakeWorkspaceRuntime(),
        modelTurnRunner: { runModelTurn },
        storage: new MemoryStorage()
      }
    );

    const initializeResponse = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never);
    expect(typeof initializeResponse.protocolVersion).toBe("number");
    const session = await agent.newSession({ cwd: ".", mcpServers: [] });
    await expect(agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "ping" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    expect(runModelTurn).toHaveBeenCalledOnce();
    const [[modelRequest]] = runModelTurn.mock.calls as [[ModelTurnRequest]];
    expect(Object.keys(modelRequest.tools)).toEqual(
      expect.arrayContaining([
        "workspace.read_file",
        "workspace.write_file",
        "workspace.list_directory",
        "workspace.search_text",
        "workspace.run_command"
      ])
    );
    expect(sessionUpdates).toEqual([
      {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "pong" }
        }
      }
    ]);
  });
});

function createFakeWorkspaceRuntime(): IWorkspaceRuntime {
  return {
    async readFile(path: string): Promise<string> {
      return `content:${path}`;
    },
    async writeFile(): Promise<void> {},
    async listDirectory(): Promise<[]> {
      return [];
    },
    async searchText(): Promise<[]> {
      return [];
    },
    async runCommand() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false
      };
    }
  };
}
