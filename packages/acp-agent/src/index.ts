import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import * as acp from "@agentclientprotocol/sdk";
import {
  experimental_createMCPClient as createMCPClient,
  type experimental_MCPClient as MCPClient
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, streamText, type CoreMessage, type ToolSet } from "ai";

type SessionState = {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly history: CoreMessage[];
  readonly mcpClients: MCPClient[];
  readonly tools: ToolSet;
  pendingPrompt: AbortController | undefined;
};

const DEFAULT_SYSTEM_PROMPT =
  "You are Fledgling, a small ACP-native assistant. Answer directly. Use tools only when they are available and useful. Tool results may include Fledgling context hints that describe identity, retention, and prompt placement for future context assembly.";

type FledglingConfig = {
  readonly mcpServers?: Record<string, McpServerConfig>;
};

type McpServerConfig =
  | {
      readonly type: "firstPartyWorkspace";
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: string[];
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers?: Record<string, string>;
    };

const configPromise = loadConfig();

class FledglingAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions = new Map<string, SessionState>();

  public constructor(connection: acp.AgentSideConnection) {
    this.#connection = connection;
  }

  public async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {}
    };
  }

  public async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const { mcpClients, tools } = await createConfiguredTools(params.cwd);
    const session: SessionState = {
      id: randomUUID(),
      cwd: params.cwd,
      history: [],
      mcpClients,
      tools,
      pendingPrompt: undefined
    };

    this.#sessions.set(session.id, session);

    return {
      sessionId: session.id
    };
  }

  public async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  public async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${params.sessionId}`);
    }

    const userText = extractPromptText(params);
    session.history.push({ role: "user", content: userText });
    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    });

    const modelName = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    const model =
      process.env.FLEDGLING_OPENAI_API === "responses" ? openai.responses(modelName) : openai.chat(modelName);
    const result = streamText({
      model,
      system: process.env.FLEDGLING_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
      messages: session.history,
      tools: session.tools,
      toolChoice: getToolChoice(session.tools),
      stopWhen: stepCountIs(5),
      abortSignal: session.pendingPrompt.signal
    });

    let assistantText = "";

    try {
      for await (const part of result.fullStream) {
        if (process.env.FLEDGLING_DEBUG_STREAM === "1") {
          console.error(JSON.stringify({ streamPart: part.type }));
        }

        switch (part.type) {
          case "text-delta": {
            assistantText += part.text;
            await this.#connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: part.text
                }
              }
            });
            break;
          }

          case "tool-call": {
            await this.#connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: part.toolCallId,
                title: part.toolName,
                kind: "other",
                status: "pending",
                rawInput: part.input
              }
            });
            break;
          }

          case "tool-result": {
            await this.#connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: part.toolCallId,
                status: "completed",
                content: [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: stringifyToolOutput(part.output)
                    }
                  }
                ],
                rawOutput: part.output
              }
            });
            break;
          }

          case "tool-error": {
            await this.#connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: part.toolCallId,
                status: "failed",
                content: [
                  {
                    type: "content",
                    content: {
                      type: "text",
                      text: stringifyToolOutput(part.error)
                    }
                  }
                ],
                rawOutput: toRawObject(part.error)
              }
            });
            break;
          }
        }
      }
    } catch (error: unknown) {
      if (session.pendingPrompt.signal.aborted) {
        return { stopReason: "cancelled" };
      }

      throw error;
    }

    session.history.push({ role: "assistant", content: assistantText });
    session.pendingPrompt = undefined;

    return {
      stopReason: "end_turn"
    };
  }

  public async cancel(_params: acp.CancelNotification): Promise<void> {
    this.#sessions.get(_params.sessionId)?.pendingPrompt?.abort();
  }
}

function extractPromptText(params: acp.PromptRequest): string {
  const prompt = params.prompt;

  if (typeof prompt === "string") {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join("\n");
  }

  return JSON.stringify(prompt);
}

async function loadConfig(): Promise<FledglingConfig> {
  const configPath = process.env.FLEDGLING_CONFIG
    ? path.resolve(process.env.FLEDGLING_CONFIG)
    : path.resolve(process.cwd(), "fledgling.config.json");

  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(await readFile(configPath, "utf8")) as FledglingConfig;
}

async function createConfiguredTools(
  sessionCwd: string | undefined
): Promise<{ mcpClients: MCPClient[]; tools: ToolSet }> {
  const config = await configPromise;
  const entries = Object.entries(config.mcpServers ?? {});
  const mcpClients: MCPClient[] = [];
  const tools: ToolSet = {};

  for (const [serverName, serverConfig] of entries) {
    const client = await createMCPClient({
      name: `fledgling-${serverName}`,
      transport: await createTransport(serverConfig, sessionCwd)
    });

    const serverTools = await client.tools();
    for (const [toolName, tool] of Object.entries(serverTools)) {
      tools[toExposedToolName(serverName, toolName)] = tool as unknown as ToolSet[string];
    }

    mcpClients.push(client);
  }

  return { mcpClients, tools };
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

function getToolChoice(tools: ToolSet): "auto" | { type: "tool"; toolName: string } {
  const toolName = process.env.FLEDGLING_TOOL_CHOICE;
  if (!toolName) {
    return "auto";
  }

  if (!(toolName in tools)) {
    throw new Error(`FLEDGLING_TOOL_CHOICE references unknown tool: ${toolName}`);
  }

  return { type: "tool", toolName };
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output, null, 2);
}

function toRawObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);

new acp.AgentSideConnection((connection) => new FledglingAgent(connection), stream);
