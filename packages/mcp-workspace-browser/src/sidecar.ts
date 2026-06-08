import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { IWorkspaceRuntime } from "./runtime.js";

interface ContextHint {
  readonly kind: "durable_resource" | "command_output";
  readonly identity?: string;
  readonly contentHash?: string;
  readonly tokenEstimate?: number;
  readonly placement: "session_context" | "latest_evidence";
  readonly retention: "discard_after_turn" | "retain_until_changed";
  readonly priority?: number;
  readonly routingTags?: string[];
}

export interface WebWorkspaceSidecar {
  readonly clientTransport: InMemoryTransport;
  close(): Promise<void>;
}

export async function createWebWorkspaceSidecar(runtime: IWorkspaceRuntime): Promise<WebWorkspaceSidecar> {
  const server = new McpServer(
    {
      name: "fledgling-browser-workspace",
      version: "0.0.0"
    },
    {
      instructions:
        "Browser workspace tools run through a browser-hosted MCP sidecar. Use read_file before edits; command output is latest evidence."
    }
  );
  registerWebWorkspaceTools(server, runtime);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return {
    clientTransport,
    async close(): Promise<void> {
      await server.close();
      await clientTransport.close();
    }
  };
}

export function registerWebWorkspaceTools(server: McpServer, runtime: IWorkspaceRuntime): void {
  server.registerTool(
    "workspace.read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 text file in the browser workspace.",
      inputSchema: {
        path: z.string()
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ path }) => {
      const content = await runtime.readFile(path);
      const contextHint = fileContextHint(path, content);
      return toolResult(`Read ${path}.\n\n${content}`, { path, content, contextHint }, contextHint);
    }
  );

  server.registerTool(
    "workspace.write_file",
    {
      title: "Write file",
      description: "Write a UTF-8 text file in the browser workspace.",
      inputSchema: {
        path: z.string(),
        content: z.string()
      },
      annotations: {
        destructiveHint: true
      }
    },
    async ({ path, content }) => {
      await runtime.writeFile(path, content);
      const contextHint = fileContextHint(path, content);
      return toolResult(`Wrote ${path}.`, { path, contentHash: hashText(content), contextHint }, contextHint);
    }
  );

  server.registerTool(
    "workspace.list_directory",
    {
      title: "List directory",
      description: "List files and directories in the browser workspace.",
      inputSchema: {
        path: z.string().default(".")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ path }) => {
      const entries = await runtime.listDirectory(path);
      const text = entries.map((entry) => `${entry.type}\t${entry.path}`).join("\n");
      return toolResult(text.length > 0 ? text : "Directory is empty.", { path, entries }, undefined);
    }
  );

  server.registerTool(
    "workspace.search_text",
    {
      title: "Search text",
      description: "Search text across files in the browser workspace.",
      inputSchema: {
        query: z.string(),
        path: z.string().default(".")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ query, path }) => {
      const matches = await runtime.searchText(query, path);
      const text = matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
      return toolResult(text.length > 0 ? text : "No matches.", { query, path, matches }, undefined);
    }
  );

  server.registerTool(
    "workspace.run_command",
    {
      title: "Run command",
      description: "Run a shell command in the browser workspace sidecar.",
      inputSchema: {
        command: z.string(),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().positive().default(30_000),
        maxOutputBytes: z.number().int().positive().default(20_000)
      },
      annotations: {
        destructiveHint: true
      }
    },
    async ({ command, cwd, timeoutMs, maxOutputBytes }) => {
      const result = await runtime.runCommand(command, cwd, timeoutMs, maxOutputBytes);
      const output = `exitCode: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      const contextHint = commandContextHint(command, output);
      return toolResult(output, { command, cwd, ...result, contextHint }, contextHint);
    }
  );
}

function toolResult(
  text: string,
  structuredContent: Record<string, unknown>,
  contextHint: ContextHint | undefined
): CallToolResult {
  const meta = contextHint ? { "house.pape.fledgling/context-hint": contextHint } : undefined;
  return {
    content: [{ type: "text", text }],
    structuredContent,
    _meta: meta
  };
}

function fileContextHint(path: string, content: string): ContextHint {
  return {
    kind: "durable_resource",
    identity: `browser-workspace://${path}`,
    contentHash: hashText(content),
    tokenEstimate: estimateTokens(content),
    placement: "session_context",
    retention: "retain_until_changed",
    priority: 60,
    routingTags: ["file", path]
  };
}

function commandContextHint(command: string, output: string): ContextHint {
  return {
    kind: "command_output",
    identity: `browser-command://${hashText(command)}`,
    contentHash: hashText(output),
    tokenEstimate: estimateTokens(output),
    placement: "latest_evidence",
    retention: "discard_after_turn",
    priority: 90,
    routingTags: ["command", "shell"]
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
