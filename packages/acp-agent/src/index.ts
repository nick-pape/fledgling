import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import {
  experimental_createMCPClient as createMCPClient,
  type experimental_MCPClient as MCPClient
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createOpenAI } from "@ai-sdk/openai";
import { buildContext } from "@fledgling/context-builder";
import { stepCountIs, streamText, type CoreMessage, type ToolSet } from "ai";

import { serializeError, SessionCleanup } from "./session-cleanup.js";
import { SessionStore } from "./session-store.js";

interface SessionState {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly history: CoreMessage[];
  readonly mcpClients: MCPClient[];
  readonly tools: ToolSet;
  readonly toolCallNames: Map<string, string>;
  pendingPrompt: AbortController | undefined;
}

const DEFAULT_SYSTEM_PROMPT: string =
  "You are Fledgling, a small ACP-native assistant. Answer directly. Use tools when they are available and useful. If the user asks you to inspect, create, modify, delete, search, or execute something in the workspace, use the relevant workspace tool instead of only describing what you would do. If the user asks you to write content to a file, call the file-writing tool. Do not claim you cannot access files when a relevant workspace tool is available. Tool results may include Fledgling context hints that describe identity, retention, and prompt placement for future context assembly.";

interface FledglingConfig {
  readonly mcpServers?: Record<string, McpServerConfig>;
}

type McpOrigin = "acp_client" | "config" | "first_party";

interface ResolvedMcpServer {
  readonly name: string;
  readonly origin: McpOrigin;
  readonly config: McpServerConfig;
}

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

const configPromise: Promise<FledglingConfig> = loadConfig();

class FledglingAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions: Map<string, SessionState> = new Map<string, SessionState>();
  readonly #sessionStore: SessionStore = new SessionStore();
  readonly #sessionCleanup: SessionCleanup = new SessionCleanup(
    () => this.#sessions.values(),
    () => this.#sessions.clear()
  );

  public constructor(connection: acp.AgentSideConnection) {
    this.#connection = connection;
  }

  public async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true
        }
      }
    };
  }

  public async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const { mcpClients, tools } = await createSessionTools(params.cwd, params.mcpServers);
    const session: SessionState = {
      id: this.#sessionStore.createId(),
      cwd: params.cwd,
      history: [],
      mcpClients,
      tools,
      toolCallNames: new Map(),
      pendingPrompt: undefined
    };

    this.#sessions.set(session.id, session);
    await this.#sessionStore.append({
      ...this.#sessionStore.createEventBase(session.id),
      type: "session.created",
      cwd: params.cwd,
      mcpServers: params.mcpServers.map((server) => server.name)
    });

    return {
      sessionId: session.id
    };
  }

  public async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const events = await this.#sessionStore.load(params.sessionId);
    const context = buildContext(events, { mode: "replay" });
    const { mcpClients, tools } = await createSessionTools(params.cwd, params.mcpServers);
    const session: SessionState = {
      id: params.sessionId,
      cwd: params.cwd,
      history: context.messages.map((message) => ({ role: message.role, content: message.content }) as CoreMessage),
      mcpClients,
      tools,
      toolCallNames: new Map(),
      pendingPrompt: undefined
    };

    this.#sessions.set(session.id, session);
    await this.#sessionStore.append({
      ...this.#sessionStore.createEventBase(session.id),
      type: "session.loaded",
      cwd: params.cwd,
      source: "session.load"
    });
    await replaySessionHistory(this.#connection, session);

    return {};
  }

  public async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  public async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return {};
  }

  public async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${params.sessionId}`);
    }

    const userText = extractPromptText(params);
    session.history.push({ role: "user", content: userText });
    await this.#sessionStore.append({
      ...this.#sessionStore.createEventBase(session.id),
      type: "message.user",
      text: userText
    });
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
            session.toolCallNames.set(part.toolCallId, part.toolName);
            await this.#sessionStore.append({
              ...this.#sessionStore.createEventBase(session.id),
              type: "tool.call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              title: part.toolName,
              rawInput: part.input
            });
            await this.#connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: part.toolCallId,
                title: part.toolName,
                kind: "other",
                status: "pending",
                rawInput: toRawObject(part.input)
              }
            });
            break;
          }

          case "tool-result": {
            await this.#sessionStore.append({
              ...this.#sessionStore.createEventBase(session.id),
              type: "tool.result",
              toolCallId: part.toolCallId,
              toolName: session.toolCallNames.get(part.toolCallId),
              status: "completed",
              text: stringifyToolOutput(part.output),
              rawOutput: part.output,
              contextHint: extractContextHint(part.output)
            });
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
                rawOutput: toRawObject(part.output)
              }
            });
            break;
          }

          case "tool-error": {
            await this.#sessionStore.append({
              ...this.#sessionStore.createEventBase(session.id),
              type: "tool.result",
              toolCallId: part.toolCallId,
              toolName: session.toolCallNames.get(part.toolCallId),
              status: "failed",
              text: stringifyToolOutput(part.error),
              rawOutput: toRawObject(part.error),
              contextHint: undefined
            });
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
    await this.#sessionStore.append({
      ...this.#sessionStore.createEventBase(session.id),
      type: "message.assistant",
      text: assistantText
    });

    return {
      stopReason: "end_turn"
    };
  }

  public async cancel(_params: acp.CancelNotification): Promise<void> {
    this.#sessions.get(_params.sessionId)?.pendingPrompt?.abort();
  }

  public closeAllSessions(reason: string): Promise<void> {
    return this.#sessionCleanup.closeAll(reason);
  }
}

async function replaySessionHistory(connection: acp.AgentSideConnection, session: SessionState): Promise<void> {
  for (const message of session.history) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = messageContentToText(message.content);
    if (!text) {
      continue;
    }

    await connection.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: {
          type: "text",
          text
        }
      }
    });
  }
}

function messageContentToText(content: CoreMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join("\n");
  }

  return JSON.stringify(content);
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

        if (typeof part === "object" && "text" in part && typeof part.text === "string") {
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

async function createSessionTools(
  sessionCwd: string | undefined,
  clientMcpServers: acp.McpServer[]
): Promise<{ mcpClients: MCPClient[]; tools: ToolSet }> {
  const entries = await resolveMcpServers(clientMcpServers);
  const mcpClients: MCPClient[] = [];
  const tools: ToolSet = {};

  for (const entry of entries) {
    const client = await createMCPClient({
      name: `fledgling-${entry.origin}-${entry.name}`,
      transport: await createTransport(entry.config, sessionCwd)
    });

    const serverTools = await client.tools();
    for (const [toolName, tool] of Object.entries(serverTools)) {
      const exposedToolName = toExposedToolName(entry.name, toolName);
      if (exposedToolName in tools) {
        throw new Error(`MCP tool name collision after sanitization: ${exposedToolName}`);
      }

      tools[exposedToolName] = tool as unknown as ToolSet[string];
    }

    mcpClients.push(client);
  }

  return { mcpClients, tools };
}

async function resolveMcpServers(clientMcpServers: acp.McpServer[]): Promise<ResolvedMcpServer[]> {
  const resolved = new Map<string, ResolvedMcpServer>();

  for (const server of clientMcpServers) {
    const name = sanitizeToolName(server.name);
    resolved.set(name, {
      name,
      origin: "acp_client",
      config: fromAcpMcpServer(server)
    });
  }

  const config = await configPromise;
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers ?? {})) {
    const name = sanitizeToolName(serverName);
    if (resolved.has(name)) {
      console.error(
        JSON.stringify({
          level: "warn",
          message: "Skipping configured MCP server because ACP client provided the same server name.",
          serverName: name
        })
      );
      continue;
    }

    resolved.set(name, {
      name,
      origin: serverConfig.type === "firstPartyWorkspace" ? "first_party" : "config",
      config: serverConfig
    });
  }

  return [...resolved.values()];
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

function extractContextHint(output: unknown): unknown {
  if (!output || typeof output !== "object") {
    return undefined;
  }

  if ("structuredContent" in output) {
    const structuredContent = (output as { readonly structuredContent?: unknown }).structuredContent;
    if (structuredContent && typeof structuredContent === "object" && "contextHint" in structuredContent) {
      return (structuredContent as { readonly contextHint?: unknown }).contextHint;
    }
  }

  if ("_meta" in output) {
    const meta = (output as { readonly _meta?: unknown })._meta;
    if (meta && typeof meta === "object" && "house.pape.fledgling/context-hint" in meta) {
      return (meta as { readonly ["house.pape.fledgling/context-hint"]?: unknown })[
        "house.pape.fledgling/context-hint"
      ];
    }
  }

  return undefined;
}

function toRawObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

const input: WritableStream<Uint8Array> = Writable.toWeb(process.stdout);
const output: ReadableStream<Uint8Array> = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream: ReturnType<typeof acp.ndJsonStream> = acp.ndJsonStream(input, output);

let activeAgent: FledglingAgent | undefined;
let shutdownPromise: Promise<void> | undefined;

function shutdownAgent(reason: string): Promise<void> {
  shutdownPromise ??= activeAgent?.closeAllSessions(reason) ?? Promise.resolve();
  return shutdownPromise;
}

async function shutdownAndExit(reason: string, exitCode: number): Promise<void> {
  await shutdownAgent(reason);
  process.exit(exitCode);
}

function logFatal(event: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      error: serializeError(error)
    })
  );
}

process.once("SIGINT", () => {
  shutdownAndExit("SIGINT", 130).catch((error: unknown) => {
    logFatal("shutdown_failed", error);
    process.exit(1);
  });
});

process.once("SIGTERM", () => {
  shutdownAndExit("SIGTERM", 143).catch((error: unknown) => {
    logFatal("shutdown_failed", error);
    process.exit(1);
  });
});

process.once("beforeExit", () => {
  shutdownAgent("beforeExit").catch((error: unknown) => {
    logFatal("shutdown_failed", error);
  });
});

process.once("uncaughtException", (error: Error) => {
  logFatal("uncaught_exception", error);
  shutdownAndExit("uncaughtException", 1).catch((shutdownError: unknown) => {
    logFatal("shutdown_failed", shutdownError);
    process.exit(1);
  });
});

process.once("unhandledRejection", (reason: unknown) => {
  logFatal("unhandled_rejection", reason);
  shutdownAndExit("unhandledRejection", 1).catch((error: unknown) => {
    logFatal("shutdown_failed", error);
    process.exit(1);
  });
});

// eslint-disable-next-line no-new -- AgentSideConnection owns the stdio lifecycle.
new acp.AgentSideConnection((connection) => {
  activeAgent = new FledglingAgent(connection);
  return activeAgent;
}, stream);
