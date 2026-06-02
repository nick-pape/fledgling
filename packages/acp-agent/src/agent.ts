import * as acp from "@agentclientprotocol/sdk";
import type { experimental_MCPClient as MCPClient } from "@ai-sdk/mcp";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
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

export interface FledglingAgentDependencies {
  readonly createSessionTools: typeof createSessionTools;
  readonly sessionStore: SessionStore;
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
      throw new Error(`Unknown ACP session: ${params.sessionId}`);
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

      const result = this.#dependencies.runModelTurn({
        messages: session.history,
        tools: session.tools,
        abortSignal: promptController.signal
      });

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

      session.history.push({ role: "assistant", content: assistantText });
      await this.#dependencies.sessionStore.append({
        ...this.#dependencies.sessionStore.createEventBase(session.id),
        type: "message.assistant",
        text: assistantText
      });

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
