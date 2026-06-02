import { createHash } from "node:crypto";
import path from "node:path";

export const CONTEXT_HINT_META_KEY: string = "house.pape.fledgling/context-hint";
export const TOOL_META_KEY: string = "house.pape.fledgling/tool";

export type ContextKind =
  | "ephemeral_observation"
  | "durable_resource"
  | "workspace_map"
  | "diagnostic"
  | "command_output"
  | "user_memory";

export type ContextPlacement =
  | "stable_prefix"
  | "session_context"
  | "turn_context"
  | "latest_evidence"
  | "do_not_inline";

export type ContextRetention =
  | "discard_after_turn"
  | "summarize_after_turn"
  | "retain_until_changed"
  | "retain_for_session";

export interface ContextHint {
  readonly kind: ContextKind;
  readonly identity?: string;
  readonly contentHash?: string;
  readonly tokenEstimate?: number;
  readonly placement: ContextPlacement;
  readonly retention: ContextRetention;
  readonly priority?: number;
  readonly routingTags?: string[];
}

export function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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
