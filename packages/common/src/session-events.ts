/**
 * A chat-style message included in context sent to a model.
 */
export interface ContextMessage {
  /**
   * The message author role.
   */
  readonly role: "user" | "assistant" | "system";

  /**
   * Message content.
   */
  readonly content: FledglingModelMessageContent;
}

/**
 * Model-message content that can be reconstructed from persisted session events.
 */
export type FledglingModelMessageContent = string | readonly FledglingModelMessageContentPart[];

/**
 * Model-message content parts supported by Fledgling.
 */
export type FledglingModelMessageContentPart = FledglingTextContentPart | FledglingImageContentPart;

/**
 * Persisted user-message content.
 */
export type FledglingMessageContent = string | readonly FledglingMessageContentPart[];

/**
 * Structured user-authored content persisted from ACP prompt blocks.
 */
export type FledglingMessageContentPart =
  | FledglingTextContentPart
  | FledglingResourceLinkContentPart
  | FledglingImageContentPart
  | FledglingUnsupportedContentPart;

/**
 * Text prompt content.
 */
export interface FledglingTextContentPart {
  /** Content discriminator. */
  readonly type: "text";

  /** Text supplied by the user. */
  readonly text: string;
}

/**
 * Link to a resource referenced by the prompt.
 */
export interface FledglingResourceLinkContentPart {
  /** Content discriminator. */
  readonly type: "resource_link";

  /** Resource URI. */
  readonly uri: string;

  /** Resource name supplied by the ACP client. */
  readonly name: string;

  /** Optional display title. */
  readonly title?: string;

  /** Optional description. */
  readonly description?: string;

  /** Optional MIME type. */
  readonly mimeType?: string;

  /** Optional byte size. */
  readonly size?: number;
}

/**
 * Image prompt content.
 */
export interface FledglingImageContentPart {
  /** Content discriminator. */
  readonly type: "image";

  /** Base64-encoded image data. */
  readonly data: string;

  /** Image MIME type. */
  readonly mimeType: string;

  /** Optional source URI supplied by the ACP client. */
  readonly uri?: string;
}

/**
 * Prompt content that Fledgling does not semantically support yet.
 */
export interface FledglingUnsupportedContentPart {
  /** Content discriminator. */
  readonly type: "unsupported";

  /** Original ACP block type, when available. */
  readonly originalType?: string;

  /** JSON-serializable raw block payload. */
  readonly raw: unknown;
}

/**
 * Discriminated union of persisted session events.
 */
export type SessionEvent =
  | SessionCreatedEvent
  | SessionLoadedEvent
  | SessionModeChangedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionErrorEvent
  | CompactionEvent;

/**
 * Fields shared by every persisted session event.
 */
export interface SessionEventBase {
  /**
   * Unique identifier for this event.
   */
  readonly eventId: string;

  /**
   * Identifier for the session that owns this event.
   */
  readonly sessionId: string;

  /**
   * Event creation time as an ISO timestamp.
   */
  readonly timestamp: string;
}

/**
 * Event recorded when a session is created.
 */
export type SessionCreatedEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "session.created";

  /** Working directory associated with the session, when known. */
  readonly cwd: string | undefined;

  /** Names of MCP servers available when the session was created. */
  readonly mcpServers: readonly string[];
};

/**
 * Event recorded when an existing session is loaded.
 */
export type SessionLoadedEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "session.loaded";

  /** Working directory associated with the session, when known. */
  readonly cwd: string | undefined;

  /** Source that supplied the loaded session data. */
  readonly source: string;
};

/**
 * Event recorded when an ACP session mode changes.
 */
export type SessionModeChangedEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "session.mode_changed";

  /** Active ACP session mode after the change. */
  readonly modeId: string;
};

/**
 * Event containing a user message.
 */
export type UserMessageEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "message.user";

  /** Fallback user-authored message text for display, replay, and legacy context. */
  readonly text: string;

  /** Structured user-authored content, when available. */
  readonly content?: FledglingMessageContent;
};

/**
 * Event containing an assistant message.
 */
export type AssistantMessageEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "message.assistant";

  /** Assistant-authored message text. */
  readonly text: string;
};

/**
 * Event recorded when a tool call starts.
 */
export type ToolCallEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "tool.call";

  /** Identifier used to match this call with its result. */
  readonly toolCallId: string;

  /** Tool name requested by the model. */
  readonly toolName: string;

  /** Human-readable title for the tool call. */
  readonly title: string;

  /** Raw input supplied to the tool. */
  readonly rawInput: unknown;
};

/**
 * Event recorded when a tool call completes or fails.
 */
export type ToolResultEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "tool.result";

  /** Identifier matching the corresponding tool call. */
  readonly toolCallId: string;

  /** Tool name, when known at result time. */
  readonly toolName: string | undefined;

  /** Completion status for the tool call. */
  readonly status: "completed" | "failed";

  /** Textual output produced for display or model context. */
  readonly text: string;

  /** Raw output returned by the tool. */
  readonly rawOutput: unknown;

  /** Context hint metadata returned with the tool result. */
  readonly contextHint: unknown;
};

/**
 * Event recorded when a session-level operation fails.
 */
export type SessionErrorEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "session.error";

  /** Stable category for the error. */
  readonly kind: "model_start_failed" | "model_stream_failed" | "prompt_cleanup_failed";

  /** Session phase in which the error occurred. */
  readonly phase: "model_start" | "model_stream" | "cleanup";

  /** Human-readable error message. */
  readonly message: string;

  /** Whether the session can continue after the error. */
  readonly recoverable: boolean;

  /** Whether assistant text was persisted before the error. */
  readonly assistantTextPersisted: boolean;

  /** Error class or name, when available. */
  readonly errorName: string | undefined;

  /** Error code, when available. */
  readonly errorCode: string | undefined;
};

/**
 * Event recorded when session context is compacted.
 */
export type CompactionEvent = SessionEventBase & {
  /** Event discriminator. */
  readonly type: "context.compacted";

  /** Target token budget for compaction. */
  readonly targetTokens: number;

  /** Estimated token count before compaction. */
  readonly estimatedTokensBefore: number;

  /** Estimated token count after compaction. */
  readonly estimatedTokensAfter: number;

  /** Event identifiers removed from inline context by compaction. */
  readonly droppedEventIds: readonly string[];
};

/**
 * Session event kinds that can be discarded or summarized during compaction.
 */
export type VolatileEventType = "tool.call" | "tool.result";
