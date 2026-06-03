import * as acp from "@agentclientprotocol/sdk";
import { buildContext } from "@fledgling/context-builder";
import type { CoreMessage, ToolSet } from "ai";

import type { FledglingAgentDependencies, IClosable } from "./interfaces.js";
import {
  createPromptRpcError,
  formatPromptErrorKind,
  normalizePromptError,
  sanitizeErrorMessage
} from "./prompt-errors.js";
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
  readonly clients: IClosable[];
  readonly tools: ToolSet;
  readonly toolCallNames: Map<string, string>;
  pendingPrompt: AbortController | undefined;
  promptQueue: Promise<void>;
}

export class FledglingAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions: Map<string, SessionState> = new Map<string, SessionState>();
  readonly #dependencies: FledglingAgentDependencies;
  readonly #sessionCleanup: SessionCleanup;

  public constructor(connection: acp.AgentSideConnection, dependencies: FledglingAgentDependencies) {
    this.#connection = connection;
    this.#dependencies = dependencies;
    this.#sessionCleanup = new SessionCleanup(
      () => this.#sessions.values(),
      () => this.#sessions.clear(),
      dependencies.logger
    );
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
      sessionId: session.id
    };
  }

  public async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const events = await this.#dependencies.sessionManager.loadEvents(params.sessionId);
    const context = buildContext(events, { mode: "replay" });
    const { clients, tools } = await this.#dependencies.toolProvider.createSessionTools({
      cwd: params.cwd,
      mcpServers: params.mcpServers
    });
    const existingSession = this.#sessions.get(params.sessionId);
    const session: SessionState = {
      id: params.sessionId,
      cwd: params.cwd,
      history: context.messages.map((message) => ({ role: message.role, content: message.content }) as CoreMessage),
      clients,
      tools,
      toolCallNames: new Map(),
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
      await this.#dependencies.sessionManager.appendEvent({
        ...this.#dependencies.sessionManager.createEventBase(session.id),
        type: "message.user",
        text: userText
      });

      let result: ReturnType<FledglingAgentDependencies["modelTurnRunner"]["runModelTurn"]>;
      try {
        result = this.#dependencies.modelTurnRunner.runModelTurn({
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
          if (this.#dependencies.debugStream) {
            this.#dependencies.logger?.debug?.({ streamPart: part.type });
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
              await this.#dependencies.sessionManager.appendEvent({
                ...this.#dependencies.sessionManager.createEventBase(session.id),
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
              await this.#dependencies.sessionManager.appendEvent({
                ...this.#dependencies.sessionManager.createEventBase(session.id),
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
