export interface ContextMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export type SessionEvent =
  | SessionCreatedEvent
  | SessionLoadedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionErrorEvent
  | CompactionEvent;

export interface SessionEventBase {
  readonly eventId: string;
  readonly sessionId: string;
  readonly timestamp: string;
}

export type SessionCreatedEvent = SessionEventBase & {
  readonly type: "session.created";
  readonly cwd: string | undefined;
  readonly mcpServers: readonly string[];
};

export type SessionLoadedEvent = SessionEventBase & {
  readonly type: "session.loaded";
  readonly cwd: string | undefined;
  readonly source: string;
};

export type UserMessageEvent = SessionEventBase & {
  readonly type: "message.user";
  readonly text: string;
};

export type AssistantMessageEvent = SessionEventBase & {
  readonly type: "message.assistant";
  readonly text: string;
};

export type ToolCallEvent = SessionEventBase & {
  readonly type: "tool.call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly title: string;
  readonly rawInput: unknown;
};

export type ToolResultEvent = SessionEventBase & {
  readonly type: "tool.result";
  readonly toolCallId: string;
  readonly toolName: string | undefined;
  readonly status: "completed" | "failed";
  readonly text: string;
  readonly rawOutput: unknown;
  readonly contextHint: unknown;
};

export type SessionErrorEvent = SessionEventBase & {
  readonly type: "session.error";
  readonly kind: "model_start_failed" | "model_stream_failed" | "prompt_cleanup_failed";
  readonly phase: "model_start" | "model_stream" | "cleanup";
  readonly message: string;
  readonly recoverable: boolean;
  readonly assistantTextPersisted: boolean;
  readonly errorName: string | undefined;
  readonly errorCode: string | undefined;
};

export type CompactionEvent = SessionEventBase & {
  readonly type: "context.compacted";
  readonly targetTokens: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly droppedEventIds: readonly string[];
};

export type VolatileEventType = "tool.call" | "tool.result";
