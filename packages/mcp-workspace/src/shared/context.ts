import {
  CONTEXT_HINT_META_KEY,
  TOOL_META_KEY,
  type ContextHint,
  type ContextRetention
} from "@fledgling/common";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type { ContextHint } from "@fledgling/common";

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
