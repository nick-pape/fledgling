import * as acp from "@agentclientprotocol/sdk";
import { buildContext } from "@fledgling/context-builder";
import type { SessionEvent } from "@fledgling/common";
import type { CoreMessage, JSONValue, ToolSet } from "ai";

import type { FledglingAgentDependencies, IClosable } from "./interfaces.js";
import {
  createPromptRpcError,
  formatPromptErrorKind,
  normalizePromptError,
  sanitizeErrorMessage
} from "./prompt-errors.js";
import {
  convertPromptContent,
  extractContextHint,
  messageContentToText,
  persistedContentToModelContent,
  renderPromptContent,
  stringifyToolOutput,
  toRawObject
} from "./prompt-content.js";
import { SessionCleanup } from "./session-cleanup.js";

type AssistantHistoryPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    };

type ToolResultOutput =
  | {
      readonly type: "text" | "error-text";
      readonly value: string;
    }
  | {
      readonly type: "json" | "error-json";
      readonly value: JSONValue;
    };

interface ToolHistoryBuilder {
  pendingAssistantText: string;
  readonly pendingAssistantParts: AssistantHistoryPart[];
}

interface SessionState {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly history: CoreMessage[];
  readonly clients: IClosable[];
  readonly tools: ToolSet;
  readonly toolCallNames: Map<string, string>;
  modeId: FledglingSessionModeId;
  pendingPrompt: AbortController | undefined;
  promptQueue: Promise<void>;
}

type FledglingSessionModeId = "read" | "write";

const DEFAULT_SESSION_MODE_ID: FledglingSessionModeId = "write";

const SESSION_MODES: readonly acp.SessionMode[] = [
  {
    id: "read",
    name: "Read",
    description: "Inspect the workspace without file mutations or command execution."
  },
  {
    id: "write",
    name: "Write",
    description: "Use all available workspace tools, including writes and command execution."
  }
];

const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "workspace_write_file",
  "workspace_replace_range",
  "workspace_run_command",
  "workspace.write_file",
  "workspace.replace_range",
  "workspace.run_command"
]);

/** ACP agent implementation that manages sessions, model turns, tools, and event persistence. */
export class FledglingAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions: Map<string, SessionState> = new Map<string, SessionState>();
  readonly #dependencies: FledglingAgentDependencies;
  readonly #sessionCleanup: SessionCleanup;

  /** Creates an ACP agent bound to a connection and host-provided dependencies. */
  public constructor(connection: acp.AgentSideConnection, dependencies: FledglingAgentDependencies) {
    this.#connection = connection;
    this.#dependencies = dependencies;
    this.#sessionCleanup = new SessionCleanup(
      () => this.#sessions.values(),
      () => this.#sessions.clear(),
      dependencies.logger
    );
  }

  /** Reports the ACP protocol version and agent capabilities. */
  public async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true
        },
        promptCapabilities: createPromptCapabilities(this.#dependencies)
      },
      authMethods: []
    };
  }

  /** Creates a new ACP session with tools for the requested working directory and MCP servers. */
  public async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const { clients, tools } = await this.#dependencies.toolProvider.createSessionTools({
      cwd: params.cwd,
      mcpServers: params.mcpServers
    });
    const session: SessionState = {
      id: this.#dependencies.sessionManager.createSessionId(),
      cwd: params.cwd,
      history: [],
      clients,
      tools,
      toolCallNames: new Map(),
      modeId: DEFAULT_SESSION_MODE_ID,
      pendingPrompt: undefined,
      promptQueue: Promise.resolve()
    };

    this.#sessions.set(session.id, session);
    await this.#dependencies.sessionManager.appendEvent({
      ...this.#dependencies.sessionManager.createEventBase(session.id),
      type: "session.created",
      cwd: params.cwd,
      mcpServers: params.mcpServers.map((server) => server.name)
    });

    return {
      sessionId: session.id,
      modes: createSessionModeState(session.modeId)
    };
  }

  /** Loads an existing session from persisted events and replays visible message history. */
  public async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const events = await this.#dependencies.sessionManager.loadEvents(params.sessionId);
    const context = buildContext(events, { mode: "replay" });
    const { clients, tools } = await this.#dependencies.toolProvider.createSessionTools({
      cwd: params.cwd,
      mcpServers: params.mcpServers
    });
    const existingSession = this.#sessions.get(params.sessionId);
    const modeId = restoreSessionMode(events);
    const session: SessionState = {
      id: params.sessionId,
      cwd: params.cwd,
      history: context.messages.map((message) => {
        if (message.role === "user") {
          return {
            role: "user",
            content: persistedContentToModelContent(
              message.content,
              renderPromptContent(message.content),
              this.#dependencies.promptContent
            )
          } as CoreMessage;
        }

        return { role: message.role, content: message.content } as CoreMessage;
      }),
      clients,
      tools,
      toolCallNames: new Map(),
      modeId,
      pendingPrompt: undefined,
      promptQueue: Promise.resolve()
    };

    if (existingSession) {
      await this.#sessionCleanup.closeSession(existingSession, "session-replaced");
    }

    this.#sessions.set(session.id, session);
    await this.#dependencies.sessionManager.appendEvent({
      ...this.#dependencies.sessionManager.createEventBase(session.id),
      type: "session.loaded",
      cwd: params.cwd,
      source: "session.load"
    });
    await replaySessionHistory(this.#connection, session);

    return {
      modes: createSessionModeState(session.modeId)
    };
  }

  /** Handles ACP authentication requests. */
  public async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    throw new Error(`Unsupported ACP authentication method: ${sanitizeErrorMessage(params.methodId)}`);
  }

  /** Accepts ACP session mode updates. */
  public async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${sanitizeErrorMessage(params.sessionId)}`);
    }

    const modeId = parseSessionModeId(params.modeId);
    session.modeId = modeId;
    await this.#dependencies.sessionManager.appendEvent({
      ...this.#dependencies.sessionManager.createEventBase(session.id),
      type: "session.mode_changed",
      modeId
    });
    await this.#connection.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: modeId
      }
    });

    return {};
  }

  /** Queues and runs a prompt against an active session. */
  public async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${sanitizeErrorMessage(params.sessionId)}`);
    }

    const response = session.promptQueue
      .catch(() => undefined)
      .then(() => {
        if (this.#sessions.get(session.id) !== session) {
          return { stopReason: "cancelled" } satisfies acp.PromptResponse;
        }

        return this.#runPrompt(session, params);
      });
    session.promptQueue = response.then(
      () => undefined,
      () => undefined
    );

    return response;
  }

  async #runPrompt(session: SessionState, params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const userPrompt = convertPromptContent(params, this.#dependencies.promptContent);
    const promptController = new AbortController();
    session.pendingPrompt = promptController;

    let assistantText = "";
    const toolHistory: ToolHistoryBuilder = {
      pendingAssistantText: "",
      pendingAssistantParts: []
    };

    try {
      session.history.push({ role: "user", content: userPrompt.modelContent });
      await this.#dependencies.sessionManager.appendEvent({
        ...this.#dependencies.sessionManager.createEventBase(session.id),
        type: "message.user",
        text: userPrompt.text,
        content: userPrompt.content
      });

      let result: ReturnType<FledglingAgentDependencies["modelTurnRunner"]["runModelTurn"]>;
      try {
        result = this.#dependencies.modelTurnRunner.runModelTurn({
          messages: session.history,
          tools: toolsForMode(session.tools, session.modeId),
          abortSignal: promptController.signal
        });
      } catch (error: unknown) {
        await this.#recordPromptError(session, params.sessionId, {
          error,
          kind: "model_start_failed",
          phase: "model_start",
          assistantTextPersisted: false
        });
        throw createPromptRpcError(error, "model_start");
      }

      try {
        for await (const part of result.fullStream) {
          if (this.#dependencies.debugStream) {
            this.#dependencies.logger?.debug?.({ streamPart: part.type });
          }

          switch (part.type) {
            case "text-delta": {
              assistantText += part.text;
              toolHistory.pendingAssistantText += part.text;
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
              appendAssistantToolCall(toolHistory, part);
              await this.#dependencies.sessionManager.appendEvent({
                ...this.#dependencies.sessionManager.createEventBase(session.id),
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
              const safeOutput = toSafeRawValue(part.output);
              flushAssistantToolHistory(session, toolHistory);
              appendToolResultHistory(session, {
                toolCallId: part.toolCallId,
                toolName: session.toolCallNames.get(part.toolCallId),
                output: safeOutput,
                status: "completed"
              });
              await this.#dependencies.sessionManager.appendEvent({
                ...this.#dependencies.sessionManager.createEventBase(session.id),
                type: "tool.result",
                toolCallId: part.toolCallId,
                toolName: session.toolCallNames.get(part.toolCallId),
                status: "completed",
                text: stringifyToolOutput(part.output),
                rawOutput: safeOutput,
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
                  rawOutput: toRawObject(safeOutput)
                }
              });
              break;
            }

            case "tool-error": {
              const safeError = toSafeRawValue(part.error);
              flushAssistantToolHistory(session, toolHistory);
              appendToolResultHistory(session, {
                toolCallId: part.toolCallId,
                toolName: session.toolCallNames.get(part.toolCallId),
                output: safeError,
                status: "failed"
              });
              await this.#dependencies.sessionManager.appendEvent({
                ...this.#dependencies.sessionManager.createEventBase(session.id),
                type: "tool.result",
                toolCallId: part.toolCallId,
                toolName: session.toolCallNames.get(part.toolCallId),
                status: "failed",
                text: stringifyToolOutput(part.error),
                rawOutput: toRawObject(safeError),
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
                  rawOutput: toRawObject(safeError)
                }
              });
              break;
            }
          }
        }
      } catch (error: unknown) {
        if (promptController.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        const assistantTextPersisted = assistantText.length > 0;
        flushAssistantToolHistory(session, toolHistory);
        appendAssistantTextHistory(session, toolHistory);
        if (assistantTextPersisted) {
          await this.#persistAssistantMessage(session, assistantText);
        }

        await this.#recordPromptError(session, params.sessionId, {
          error,
          kind: "model_stream_failed",
          phase: "model_stream",
          assistantTextPersisted
        });
        throw createPromptRpcError(error, "model_stream");
      }

      flushAssistantToolHistory(session, toolHistory);
      appendAssistantTextHistory(session, toolHistory);
      await this.#persistAssistantMessage(session, assistantText);

      return {
        stopReason: "end_turn"
      };
    } catch (error: unknown) {
      if (promptController.signal.aborted) {
        return { stopReason: "cancelled" };
      }

      throw error;
    } finally {
      if (session.pendingPrompt === promptController) {
        session.pendingPrompt = undefined;
      }
    }
  }

  async #persistAssistantMessage(session: SessionState, assistantText: string): Promise<void> {
    await this.#dependencies.sessionManager.appendEvent({
      ...this.#dependencies.sessionManager.createEventBase(session.id),
      type: "message.assistant",
      text: assistantText
    });
  }

  async #recordPromptError(
    session: SessionState,
    sessionId: string,
    options: {
      readonly error: unknown;
      readonly kind: "model_start_failed" | "model_stream_failed" | "prompt_cleanup_failed";
      readonly phase: "model_start" | "model_stream" | "cleanup";
      readonly assistantTextPersisted: boolean;
    }
  ): Promise<void> {
    const normalized = normalizePromptError(options.error, options.kind, options.phase);
    await this.#connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `\n\n[Fledgling error: ${formatPromptErrorKind(normalized.kind)}. ${normalized.message}]`
        }
      }
    });
    await this.#dependencies.sessionManager.appendEvent({
      ...this.#dependencies.sessionManager.createEventBase(session.id),
      type: "session.error",
      kind: normalized.kind,
      phase: normalized.phase,
      message: normalized.message,
      recoverable: normalized.recoverable,
      assistantTextPersisted: options.assistantTextPersisted,
      errorName: normalized.errorName,
      errorCode: normalized.errorCode
    });
  }

  /** Cancels the active prompt for the requested session, when one is running. */
  public async cancel(_params: acp.CancelNotification): Promise<void> {
    this.#sessions.get(_params.sessionId)?.pendingPrompt?.abort();
  }

  /** Closes all active sessions and their backing clients. */
  public closeAllSessions(reason: string): Promise<void> {
    return this.#sessionCleanup.closeAll(reason);
  }
}

function appendAssistantToolCall(
  toolHistory: ToolHistoryBuilder,
  part: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: unknown;
  }
): void {
  if (toolHistory.pendingAssistantText) {
    toolHistory.pendingAssistantParts.push({ type: "text", text: toolHistory.pendingAssistantText });
    toolHistory.pendingAssistantText = "";
  }

  toolHistory.pendingAssistantParts.push({
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input
  });
}

function flushAssistantToolHistory(session: SessionState, toolHistory: ToolHistoryBuilder): void {
  if (toolHistory.pendingAssistantParts.length === 0) {
    return;
  }

  if (toolHistory.pendingAssistantText) {
    toolHistory.pendingAssistantParts.push({ type: "text", text: toolHistory.pendingAssistantText });
    toolHistory.pendingAssistantText = "";
  }

  session.history.push({
    role: "assistant",
    content: [...toolHistory.pendingAssistantParts]
  } as CoreMessage);
  toolHistory.pendingAssistantParts.length = 0;
}

function appendAssistantTextHistory(session: SessionState, toolHistory: ToolHistoryBuilder): void {
  if (!toolHistory.pendingAssistantText) {
    return;
  }

  session.history.push({ role: "assistant", content: toolHistory.pendingAssistantText });
  toolHistory.pendingAssistantText = "";
}

function appendToolResultHistory(
  session: SessionState,
  result: {
    readonly toolCallId: string;
    readonly toolName: string | undefined;
    readonly output: unknown;
    readonly status: "completed" | "failed";
  }
): void {
  session.history.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: result.toolCallId,
        toolName: result.toolName ?? "unknown_tool",
        output: toToolResultOutput(result.output, result.status)
      }
    ]
  } as CoreMessage);
}

function toToolResultOutput(output: unknown, status: "completed" | "failed"): ToolResultOutput {
  if (status === "failed") {
    return {
      type: "error-text",
      value: stringifyModelToolOutput(output)
    };
  }

  const jsonValue = toJsonValue(output);
  if (jsonValue !== undefined) {
    return {
      type: "json",
      value: jsonValue
    };
  }

  return {
    type: "text",
    value: stringifyModelToolOutput(output)
  };
}

function stringifyModelToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (output instanceof Error) {
    return output.message;
  }

  if (output === undefined || typeof output === "function" || typeof output === "symbol") {
    return String(output);
  }

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function toJsonValue(value: unknown): JSONValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    return undefined;
  }
}

function toSafeRawValue(value: unknown): unknown {
  if (value instanceof Error) {
    return toRawObject(value);
  }

  try {
    JSON.stringify(value);
    return value;
  } catch {
    return stringifyModelToolOutput(value);
  }
}

async function replaySessionHistory(connection: acp.AgentSideConnection, session: SessionState): Promise<void> {
  for (const message of session.history) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = message.role === "assistant" ? assistantContentToReplayText(message.content) : messageContentToText(message.content);
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

function assistantContentToReplayText(content: CoreMessage["content"]): string {
  if (!Array.isArray(content)) {
    return messageContentToText(content);
  }

  return content
    .map((part) => {
      if (typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function createSessionModeState(modeId: FledglingSessionModeId): acp.SessionModeState {
  return {
    currentModeId: modeId,
    availableModes: [...SESSION_MODES]
  };
}

function createPromptCapabilities(dependencies: FledglingAgentDependencies): acp.PromptCapabilities | undefined {
  return dependencies.promptContent?.imageInput ? { image: true } : undefined;
}

function parseSessionModeId(modeId: string): FledglingSessionModeId {
  if (modeId === "read" || modeId === "write") {
    return modeId;
  }

  throw new Error(`Unsupported ACP session mode: ${sanitizeErrorMessage(modeId)}`);
}

function restoreSessionMode(events: readonly SessionEvent[]): FledglingSessionModeId {
  let modeId: FledglingSessionModeId = DEFAULT_SESSION_MODE_ID;
  for (const event of events) {
    if (event.type === "session.mode_changed") {
      modeId = parseSessionModeId(event.modeId);
    }
  }

  return modeId;
}

function toolsForMode(tools: ToolSet, modeId: FledglingSessionModeId): ToolSet {
  if (modeId === "write") {
    return tools;
  }

  return Object.fromEntries(
    Object.entries(tools).filter(([toolName]) => !MUTATING_TOOL_NAMES.has(toolName))
  ) as ToolSet;
}
