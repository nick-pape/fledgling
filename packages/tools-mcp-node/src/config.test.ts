import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { NodeMcpToolProvider } from "./index.js";

let tempDir: string | undefined;

describe("loadMcpServersFromConfig", () => {
  const originalConfig = process.env.FLEDGLING_CONFIG;

  afterEach(async () => {
    restoreEnv("FLEDGLING_CONFIG", originalConfig);

    const cleanupDir = tempDir;
    tempDir = undefined;
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  });

  it("loads MCP servers from Fledgling config files", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-tools-mcp-node-test-"));
    const configFile = path.join(tempDir, "config.json");
    process.env.FLEDGLING_CONFIG = configFile;
    await writeFile(
      configFile,
      JSON.stringify({
        mcpServers: {
          workspace: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            env: {
              A: "B"
            }
          }
        }
      }),
      "utf8"
    );

    expect(await loadConfig()).toEqual({
      mcpServers: {
        workspace: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: {
            A: "B"
          }
        }
      }
    });
  });

  it("rejects ACP server names that collide after sanitization", async () => {
    const provider = new NodeMcpToolProvider(Promise.resolve({}));

    await expect(
      provider.createSessionTools({
        cwd: undefined,
        mcpServers: [
          { name: "one.two", command: "node", args: [], env: [] },
          { name: "one_two", command: "node", args: [], env: [] }
        ]
      })
    ).rejects.toThrow("MCP server name collision after sanitization: one_two");
  });

  it("rejects configured server names that collide after sanitization", async () => {
    const provider = new NodeMcpToolProvider(
      Promise.resolve({
        mcpServers: {
          "one.two": { type: "stdio", command: "node" },
          one_two: { type: "stdio", command: "node" }
        }
      })
    );

    await expect(provider.createSessionTools({ cwd: undefined, mcpServers: [] })).rejects.toThrow(
      "Configured MCP server name collision after sanitization: one_two"
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
