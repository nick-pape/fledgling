import type * as acp from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@fledgling/common";
import type { CoreMessage, ToolSet } from "ai";

/** Common fields that identify and timestamp a persisted session event. */
export type SessionEventBase = Pick<SessionEvent, "eventId" | "sessionId" | "timestamp">;

/** A resource that can be closed when an agent session ends. */
export interface IClosable {
  /** Releases any resources held by the object. */
  close(): Promise<void> | void;
}

/** Persists and retrieves the event stream backing ACP sessions. */
export interface ISessionManager {
  /** Creates a new unique session identifier. */
  createSessionId(): string;

  /** Creates the shared event metadata for a session event. */
  createEventBase(sessionId: string): SessionEventBase;

  /** Appends an event to the session event store. */
  appendEvent(event: SessionEvent): Promise<void>;

  /** Loads all persisted events for a session. */
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
}

/** Streaming part emitted by a model turn runner. */
export type ModelStreamPart =
  | {
      /** Identifies assistant text output. */
      readonly type: "text-delta";

      /** Text emitted by the model for this stream part. */
      readonly text: string;
    }
  | {
      /** Identifies a model-requested tool call. */
      readonly type: "tool-call";

      /** Model-generated identifier for the tool call. */
      readonly toolCallId: string;

      /** Name of the tool to invoke. */
      readonly toolName: string;

      /** Raw tool input supplied by the model. */
      readonly input: unknown;
    }
  | {
      /** Identifies a successful tool result. */
      readonly type: "tool-result";

      /** Identifier of the tool call that produced this result. */
      readonly toolCallId: string;

      /** Raw output returned by the tool. */
      readonly output: unknown;
    }
  | {
      /** Identifies a failed tool result. */
      readonly type: "tool-error";

      /** Identifier of the tool call that failed. */
      readonly toolCallId: string;

      /** Error value reported by the tool invocation. */
      readonly error: unknown;
    };

/** Inputs supplied to a model for one prompt turn. */
export interface ModelTurnRequest {
  /** Conversation history to pass to the model. */
  readonly messages: CoreMessage[];

  /** Tools available to the model for this turn. */
  readonly tools: ToolSet;

  /** Abort signal that cancels model work for the prompt. */
  readonly abortSignal: AbortSignal;
}

/** Streaming model output for one prompt turn. */
export interface ModelTurnResult {
  /** Full model event stream normalized to Fledgling stream parts. */
  readonly fullStream: AsyncIterable<ModelStreamPart>;
}

/** Runs one model turn for an agent prompt. */
export interface IModelTurnRunner {
  /** Starts the model turn and returns its stream. */
  runModelTurn(request: ModelTurnRequest): ModelTurnResult;
}

/** Tools and closeable clients created for a session. */
export interface SessionTools {
  /** Clients that should be closed when the session is closed. */
  readonly clients: IClosable[];

  /** AI SDK tool set exposed to the model. */
  readonly tools: ToolSet;
}

/** Creates tools for a Fledgling ACP session. */
export interface IToolProvider {
  /** Creates the tool set and backing clients for a session request. */
  createSessionTools(request: {
    /** Working directory requested by the ACP client, when supplied. */
    readonly cwd: string | undefined;

    /** MCP servers requested for the session. */
    readonly mcpServers: acp.McpServer[];
  }): Promise<SessionTools>;
}

/** Logger used by the agent core for structured runtime diagnostics. */
export interface IRuntimeLogger {
  /** Emits an optional debug diagnostic record. */
  debug?(record: unknown): void;

  /** Emits a warning diagnostic record. */
  warn(record: unknown): void;

  /** Emits an error diagnostic record. */
  error(record: unknown): void;
}

/** Dependencies required to construct a Fledgling ACP agent. */
export interface FledglingAgentDependencies {
  /** Provides tools and closeable clients for each session. */
  readonly toolProvider: IToolProvider;

  /** Persists and loads session event history. */
  readonly sessionManager: ISessionManager;

  /** Runs model turns for prompts. */
  readonly modelTurnRunner: IModelTurnRunner;

  /** Optional structured logger for diagnostics and cleanup failures. */
  readonly logger?: IRuntimeLogger;

  /** Enables debug logging for streamed model part types. */
  readonly debugStream?: boolean;
}
