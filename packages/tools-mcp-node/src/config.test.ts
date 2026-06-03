import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

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
          command: "node",
          args: ["server.js"],
          env: {
            A: "B"
          }
        }
      }
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
