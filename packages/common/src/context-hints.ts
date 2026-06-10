import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Metadata key used to attach a {@link ContextHint} to tool results or other
 * contextual payloads.
 */
export const CONTEXT_HINT_META_KEY: string = "house.pape.fledgling/context-hint";

/**
 * Metadata key used to identify payloads that came from tool execution.
 */
export const TOOL_META_KEY: string = "house.pape.fledgling/tool";

/**
 * Describes the broad class of context represented by a {@link ContextHint}.
 */
export type ContextKind =
  | "ephemeral_observation"
  | "durable_resource"
  | "workspace_map"
  | "diagnostic"
  | "command_output"
  | "user_memory";

/**
 * Indicates where hinted context should be placed when constructing model
 * input.
 */
export type ContextPlacement =
  | "stable_prefix"
  | "session_context"
  | "turn_context"
  | "latest_evidence"
  | "do_not_inline";

/**
 * Indicates how long hinted context should be retained.
 */
export type ContextRetention =
  | "discard_after_turn"
  | "summarize_after_turn"
  | "retain_until_changed"
  | "retain_for_session";

/**
 * Routing and retention metadata for contextual content.
 */
export interface ContextHint {
  /**
   * The broad class of context being described.
   */
  readonly kind: ContextKind;

  /**
   * Stable identity for the underlying context, such as a file path or resource
   * identifier.
   */
  readonly identity?: string;

  /**
   * Hash of the contextual content, when available.
   */
  readonly contentHash?: string;

  /**
   * Approximate number of tokens represented by the context.
   */
  readonly tokenEstimate?: number;

  /**
   * Preferred placement for the context in model input.
   */
  readonly placement: ContextPlacement;

  /**
   * Retention policy for the context.
   */
  readonly retention: ContextRetention;

  /**
   * Relative priority when selecting among multiple context hints.
   */
  readonly priority?: number;

  /**
   * Tags used to route context to consumers that understand a domain or file
   * type.
   */
  readonly routingTags?: string[];
}

/**
 * Computes a SHA-256 content hash with the package's standard prefix.
 */
export function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Estimates token count from text length.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Infers a routing tag from a file path extension.
 */
export function inferRoutingTag(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    default:
      return ext ? ext.slice(1) : "text";
  }
}
