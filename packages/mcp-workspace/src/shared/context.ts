import { createHash } from "node:crypto";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CONTEXT_HINT_META_KEY, TOOL_META_KEY } from "./constants.js";

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

export type JsonRecord = Record<string, unknown>;

export function toolMeta(
  toolKind: string,
  producesContext: boolean,
  defaultRetention: ContextRetention
): JsonRecord {
  return {
    [TOOL_META_KEY]: {
      toolKind,
      producesContext,
      defaultRetention,
      firstParty: true
    }
  };
}

export function toolResult(
  text: string,
  structuredContent: JsonRecord,
  contextHint: ContextHint
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    _meta: {
      [CONTEXT_HINT_META_KEY]: contextHint
    }
  };
}

export function contextHintForFile(
  identity: string,
  contentHash: string,
  tokenEstimate: number,
  routingTags: string[]
): ContextHint {
  return {
    kind: "durable_resource",
    identity,
    contentHash,
    tokenEstimate,
    placement: "latest_evidence",
    retention: "retain_until_changed",
    priority: 80,
    routingTags
  };
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
