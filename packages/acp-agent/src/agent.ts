import * as acp from "@agentclientprotocol/sdk";
import type { experimental_MCPClient as MCPClient } from "@ai-sdk/mcp";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { SessionErrorEvent } from "@fledgling/common";
import { buildContext } from "@fledgling/context-builder";
import { SessionStore } from "@fledgling/session-log";
import { stepCountIs, streamText, type CoreMessage, type LanguageModel, type ToolSet } from "ai";

import { createSessionTools } from "./mcp-session-tools.js";
import {
  extractContextHint,
  extractPromptText,
  messageContentToText,
  stringifyToolOutput,
  toRawObject
} from "./prompt-content.js";
import { SessionCleanup } from "./session-cleanup.js";

type SessionEventBase = ReturnType<SessionStore["createEventBase"]>;

export interface SessionStoreLike {
  createId(): string;
  createEventBase(sessionId: string): SessionEventBase;
  append(event: Parameters<SessionStore["append"]>[0]): Promise<void>;
  load(sessionId: string): Promise<Awaited<ReturnType<SessionStore["load"]>>>;
}

interface SessionState {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly history: CoreMessage[];
  readonly mcpClients: MCPClient[];
  readonly tools: ToolSet;
  readonly toolCallNames: Map<string, string>;
  pendingPrompt: AbortController | undefined;
  promptQueue: Promise<void>;
}

type ModelStreamPart =
  | {
      readonly type: "text-delta";
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly output: unknown;
    }
  | {
      readonly type: "tool-error";
      readonly toolCallId: string;
      readonly error: unknown;
    };

interface ModelTurnRequest {
  readonly messages: CoreMessage[];
  readonly tools: ToolSet;
  readonly abortSignal: AbortSignal;
}

interface ModelTurnResult {
  readonly fullStream: AsyncIterable<ModelStreamPart>;
}

type PromptErrorKind = SessionErrorEvent["kind"];
type PromptErrorPhase = SessionErrorEvent["phase"];

interface NormalizedPromptError {
  readonly kind: PromptErrorKind;
  readonly phase: PromptErrorPhase;
  readonly message: string;
  readonly recoverable: boolean;
  readonly errorName: string | undefined;
  readonly errorCode: string | undefined;
}

export interface FledglingAgentDependencies {
  readonly createSessionTools: typeof createSessionTools;
  readonly sessionStore: SessionStoreLike;
  readonly runModelTurn: (request: ModelTurnRequest) => ModelTurnResult;
}

const DEFAULT_SYSTEM_PROMPT: string =
  "You are Fledgling, a small ACP-native assistant. Answer directly. Use tools when they are available and useful. If the user asks you to inspect, create, modify, delete, search, or execute something in the workspace, use the relevant workspace tool instead of only describing what you would do. If the user asks you to write content to a file, call the file-writing tool. Do not claim you cannot access files when a relevant workspace tool is available. Tool results may include Fledgling context hints that describe identity, retention, and prompt placement for future context assembly.";

export class FledglingAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions: Map<string, SessionState> = new Map<string, SessionState>();
  readonly #dependencies: FledglingAgentDependencies;
  readonly #sessionCleanup: SessionCleanup = new SessionCleanup(
    () => this.#sessions.values(),
    () => this.#sessions.clear()
  );

  public constructor(
    connection: acp.AgentSideConnection,
    dependencies: FledglingAgentDependencies = createDefaultDependencies()
  ) {
    this.#connection = connection;
    this.#dependencies = dependencies;
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
    const { mcpClients, tools } = await this.#dependencies.createSessionTools(params.cwd, params.mcpServers);
    const session: SessionState = {
      id: this.#dependencies.sessionStore.createId(),
      cwd: params.cwd,
      history: [],
      mcpClients,
      tools,
      toolCallNames: new Map(),
      pendingPrompt: undefined,
      promptQueue: Promise.resolve()
    };

    this.#sessions.set(session.id, session);
    await this.#dependencies.sessionStore.append({
      ...this.#dependencies.sessionStore.createEventBase(session.id),
      type: "session.created",
      cwd: params.cwd,
      mcpServers: params.mcpServers.map((server) => server.name)
    });

    return {
      sessionId: session.id
    };
  }

  public async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const events = await this.#dependencies.sessionStore.load(params.sessionId);
    const context = buildContext(events, { mode: "replay" });
    const { mcpClients, tools } = await this.#dependencies.createSessionTools(params.cwd, params.mcpServers);
    const existingSession = this.#sessions.get(params.sessionId);
    const session: SessionState = {
      id: params.sessionId,
      cwd: params.cwd,
      history: context.messages.map((message) => ({ role: message.role, content: message.content }) as CoreMessage),
      mcpClients,
      tools,
      toolCallNames: new Map(),
      pendingPrompt: undefined,
      promptQueue: Promise.resolve()
    };

    if (existingSession) {
      await this.#sessionCleanup.closeSession(existingSession, "session-replaced");
    }

    this.#sessions.set(session.id, session);
    await this.#dependencies.sessionStore.append({
      ...this.#dependencies.sessionStore.createEventBase(session.id),
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
    const userText = extractPromptText(params);
    const promptController = new AbortController();
    session.pendingPrompt = promptController;

    let assistantText = "";

    try {
      session.history.push({ role: "user", content: userText });
      await this.#dependencies.sessionStore.append({
        ...this.#dependencies.sessionStore.createEventBase(session.id),
        type: "message.user",
        text: userText
      });

      let result: ModelTurnResult;
      try {
        result = this.#dependencies.runModelTurn({
          messages: session.history,
          tools: session.tools,
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
              await this.#dependencies.sessionStore.append({
                ...this.#dependencies.sessionStore.createEventBase(session.id),
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
              await this.#dependencies.sessionStore.append({
                ...this.#dependencies.sessionStore.createEventBase(session.id),
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
              await this.#dependencies.sessionStore.append({
                ...this.#dependencies.sessionStore.createEventBase(session.id),
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
        if (promptController.signal.aborted) {
          return { stopReason: "cancelled" };
        }

        const assistantTextPersisted = assistantText.length > 0;
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
    session.history.push({ role: "assistant", content: assistantText });
    await this.#dependencies.sessionStore.append({
      ...this.#dependencies.sessionStore.createEventBase(session.id),
      type: "message.assistant",
      text: assistantText
    });
  }

  async #recordPromptError(
    session: SessionState,
    sessionId: string,
    options: {
      readonly error: unknown;
      readonly kind: PromptErrorKind;
      readonly phase: PromptErrorPhase;
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
    await this.#dependencies.sessionStore.append({
      ...this.#dependencies.sessionStore.createEventBase(session.id),
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

  public async cancel(_params: acp.CancelNotification): Promise<void> {
    this.#sessions.get(_params.sessionId)?.pendingPrompt?.abort();
  }

  public closeAllSessions(reason: string): Promise<void> {
    return this.#sessionCleanup.closeAll(reason);
  }
}

function normalizePromptError(error: unknown, kind: PromptErrorKind, phase: PromptErrorPhase): NormalizedPromptError {
  return {
    kind,
    phase,
    message: sanitizeErrorMessage(extractErrorMessage(error)),
    recoverable: true,
    errorName: extractErrorName(error),
    errorCode: extractErrorCode(error)
  };
}

function createPromptRpcError(error: unknown, phase: "model_start" | "model_stream"): Error {
  const normalized = normalizePromptError(
    error,
    phase === "model_start" ? "model_start_failed" : "model_stream_failed",
    phase
  );
  return new Error(`Fledgling ${formatPromptErrorKind(normalized.kind)}: ${normalized.message}`);
}

function formatPromptErrorKind(kind: PromptErrorKind): string {
  switch (kind) {
    case "model_start_failed":
      return "model start failed";

    case "model_stream_failed":
      return "model stream failed";

    case "prompt_cleanup_failed":
      return "prompt cleanup failed";
  }
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return "Unknown error";
}

function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }

  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { readonly name?: unknown }).name;
    return typeof name === "string" ? sanitizeErrorMessage(name) : undefined;
  }

  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    return sanitizeErrorMessage(String(code));
  }

  return undefined;
}

function sanitizeErrorMessage(message: string): string {
  const withoutControlCharacters = replaceControlCharacters(stripAnsiEscapeSequences(message));
  const normalized = withoutControlCharacters.replace(/\s+/g, " ").trim() || "Unknown error";
  const redacted = normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]");

  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function stripAnsiEscapeSequences(message: string): string {
  let stripped = "";
  for (let index = 0; index < message.length; index++) {
    const code = message.charCodeAt(index);
    if (code !== 0x1b) {
      stripped += message[index];
      continue;
    }

    const next = message.charCodeAt(index + 1);
    if (next === 0x5b) {
      index += 2;
      while (index < message.length) {
        const sequenceCode = message.charCodeAt(index);
        if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) {
          break;
        }

        index++;
      }
      continue;
    }

    if (next >= 0x40 && next <= 0x5f) {
      index++;
    }
  }

  return stripped;
}

function replaceControlCharacters(message: string): string {
  let replaced = "";
  for (let index = 0; index < message.length; index++) {
    const code = message.charCodeAt(index);
    replaced += isUnsafeControlCharacter(code) ? " " : message[index];
  }

  return replaced;
}

function isUnsafeControlCharacter(code: number): boolean {
  return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
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

function createDefaultDependencies(): FledglingAgentDependencies {
  return {
    createSessionTools,
    sessionStore: new SessionStore(),
    runModelTurn: runDefaultModelTurn
  };
}

function runDefaultModelTurn(request: ModelTurnRequest): ModelTurnResult {
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
  });
  const modelName = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const model = selectOpenAiModel(openai, modelName);

  const result = streamText({
    model,
    system: process.env.FLEDGLING_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    messages: request.messages,
    tools: request.tools,
    toolChoice: getToolChoice(request.tools),
    stopWhen: stepCountIs(5),
    abortSignal: request.abortSignal
  });

  return {
    fullStream: result.fullStream as AsyncIterable<ModelStreamPart>
  };
}

function selectOpenAiModel(openai: OpenAIProvider, modelName: string): LanguageModel {
  return process.env.FLEDGLING_OPENAI_API === "responses" ? openai.responses(modelName) : openai.chat(modelName);
}
