/**
 * Provides Node.js MCP tool discovery and session tool wiring for Fledgling.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import {
  experimental_createMCPClient as createMCPClient,
  type experimental_MCPClient as MCPClient
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { closeClients, type IToolProvider, type SessionTools } from "@fledgling/agent-core";
import type { ToolSet } from "ai";

import { loadConfig, type FledglingConfig, type McpServerConfig, type ResolvedMcpServer } from "./config.js";

export type { FledglingConfig, McpServerConfig } from "./config.js";

/**
 * Creates MCP-backed tools for Fledgling sessions running in Node.js.
 */
export class NodeMcpToolProvider implements IToolProvider {
  readonly #configPromise: Promise<FledglingConfig>;

  /**
   * Initializes the provider with a configuration promise.
   *
   * @param configPromise - Resolves to MCP server configuration loaded from the host environment.
   */
  public constructor(configPromise: Promise<FledglingConfig> = loadConfig()) {
    this.#configPromise = configPromise;
  }

  /**
   * Resolves configured and client-provided MCP servers into tools for a session.
   *
   * @param request - Session context and ACP-provided MCP server declarations.
   * @returns MCP clients and tools that should be closed when the session ends.
   */
  public async createSessionTools(request: {
    readonly cwd: string | undefined;
    readonly mcpServers: acp.McpServer[];
  }): Promise<SessionTools> {
    const entries = await this.#resolveMcpServers(request.mcpServers);
    const clients: MCPClient[] = [];
    const tools: ToolSet = {};

    try {
      for (const entry of entries) {
        const client = await createMCPClient({
          name: `fledgling-${entry.origin}-${entry.name}`,
          transport: await createTransport(entry.config, request.cwd)
        });
        clients.push(client);

        const serverTools = await client.tools();
        for (const [toolName, tool] of Object.entries(serverTools)) {
          const exposedToolName = toExposedToolName(entry.name, toolName);
          if (exposedToolName in tools) {
            throw new Error(`MCP tool name collision after sanitization: ${exposedToolName}`);
          }

          tools[exposedToolName] = tool as unknown as ToolSet[string];
        }
      }
    } catch (error: unknown) {
      await closeClients(clients, "session-tools-setup-failed");
      throw error;
    }

    return { clients, tools };
  }

  async #resolveMcpServers(clientMcpServers: acp.McpServer[]): Promise<ResolvedMcpServer[]> {
    const resolved = new Map<string, ResolvedMcpServer>();

    for (const server of clientMcpServers) {
      const name = sanitizeToolName(server.name);
      if (resolved.has(name)) {
        throw new Error(`MCP server name collision after sanitization: ${name}`);
      }

      resolved.set(name, {
        name,
        origin: "acp_client",
        config: fromAcpMcpServer(server)
      });
    }

    const config = await this.#configPromise;
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers ?? {})) {
      const name = sanitizeToolName(serverName);
      const existing = resolved.get(name);
      if (existing?.origin === "acp_client") {
        console.error(
          JSON.stringify({
            level: "warn",
            message: "Skipping configured MCP server because ACP client provided the same server name.",
            serverName: name
          })
        );
        continue;
      }

      if (existing) {
        throw new Error(`Configured MCP server name collision after sanitization: ${name}`);
      }

      resolved.set(name, {
        name,
        origin: serverConfig.type === "firstPartyWorkspace" ? "first_party" : "config",
        config: serverConfig
      });
    }

    return [...resolved.values()];
  }
}

function fromAcpMcpServer(server: acp.McpServer): McpServerConfig {
  if ("type" in server) {
    return {
      type: server.type,
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header: acp.HttpHeader) => [header.name, header.value]))
    };
  }

  return {
    type: "stdio",
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map((entry: acp.EnvVariable) => [entry.name, entry.value]))
  };
}

async function createTransport(
  config: McpServerConfig,
  sessionCwd: string | undefined
): Promise<Parameters<typeof createMCPClient>[0]["transport"]> {
  switch (config.type) {
    case "firstPartyWorkspace": {
      return new Experimental_StdioMCPTransport({
        command: process.execPath,
        args: [fileURLToPath(import.meta.resolve("@fledgling/mcp-workspace"))],
        cwd: sessionCwd ?? process.cwd(),
        env: {
          FLEDGLING_WORKSPACE_ROOT: sessionCwd ?? process.cwd()
        },
        stderr: "inherit"
      });
    }

    case "stdio": {
      return new Experimental_StdioMCPTransport({
        command: config.command,
        args: config.args,
        cwd: expandConfigString(config.cwd, sessionCwd),
        env: expandEnv(config.env, sessionCwd),
        stderr: "inherit"
      });
    }

    case "http":
    case "sse":
      return {
        type: config.type,
        url: config.url,
        headers: config.headers
      };
  }
}

function expandEnv(
  env: Record<string, string> | undefined,
  sessionCwd: string | undefined
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, expandConfigString(value, sessionCwd) ?? value])
  );
}

function expandConfigString(value: string | undefined, sessionCwd: string | undefined): string | undefined {
  return value?.replaceAll("${sessionCwd}", sessionCwd ?? process.cwd());
}

function sanitizeToolName(toolName: string): string {
  return toolName.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function toExposedToolName(serverName: string, toolName: string): string {
  const localToolName = toolName.startsWith(`${serverName}.`)
    ? toolName.slice(serverName.length + 1)
    : toolName;

  return sanitizeToolName(`${serverName}_${localToolName}`);
}
