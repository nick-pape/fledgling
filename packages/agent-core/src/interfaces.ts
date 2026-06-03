import type * as acp from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@fledgling/common";
import type { CoreMessage, ToolSet } from "ai";

export type SessionEventBase = Pick<SessionEvent, "eventId" | "sessionId" | "timestamp">;

export interface IClosable {
  close(): Promise<void> | void;
}

export interface ISessionManager {
  createSessionId(): string;
  createEventBase(sessionId: string): SessionEventBase;
  appendEvent(event: SessionEvent): Promise<void>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
}

export type ModelStreamPart =
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

export interface ModelTurnRequest {
  readonly messages: CoreMessage[];
  readonly tools: ToolSet;
  readonly abortSignal: AbortSignal;
}

export interface ModelTurnResult {
  readonly fullStream: AsyncIterable<ModelStreamPart>;
}

export interface IModelTurnRunner {
  runModelTurn(request: ModelTurnRequest): ModelTurnResult;
}

export interface SessionTools {
  readonly clients: IClosable[];
  readonly tools: ToolSet;
}

export interface IToolProvider {
  createSessionTools(request: {
    readonly cwd: string | undefined;
    readonly mcpServers: acp.McpServer[];
  }): Promise<SessionTools>;
}

export interface IRuntimeLogger {
  debug?(record: unknown): void;
  warn(record: unknown): void;
  error(record: unknown): void;
}

export interface FledglingAgentDependencies {
  readonly toolProvider: IToolProvider;
  readonly sessionManager: ISessionManager;
  readonly modelTurnRunner: IModelTurnRunner;
  readonly logger?: IRuntimeLogger;
  readonly debugStream?: boolean;
}
