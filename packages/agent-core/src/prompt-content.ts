import type { PromptRequest } from "@agentclientprotocol/sdk";
import type { CoreMessage } from "ai";

/** Converts AI SDK message content into plain text for ACP replay. */
export function messageContentToText(content: CoreMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join("\n");
  }

  return JSON.stringify(content);
}

/** Extracts user prompt text from an ACP prompt request. */
export function extractPromptText(params: PromptRequest): string {
  const prompt = params.prompt;

  if (typeof prompt === "string") {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join("\n");
  }

  return JSON.stringify(prompt);
}

/** Converts tool output into text suitable for ACP content updates. */
export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output, null, 2);
}

/** Reads a Fledgling context hint from a tool output payload, when present. */
export function extractContextHint(output: unknown): unknown {
  if (!output || typeof output !== "object") {
    return undefined;
  }

  if ("structuredContent" in output) {
    const structuredContent = (output as { readonly structuredContent?: unknown }).structuredContent;
    if (structuredContent && typeof structuredContent === "object" && "contextHint" in structuredContent) {
      return (structuredContent as { readonly contextHint?: unknown }).contextHint;
    }
  }

  if ("_meta" in output) {
    const meta = (output as { readonly _meta?: unknown })._meta;
    if (meta && typeof meta === "object" && "house.pape.fledgling/context-hint" in meta) {
      return (meta as { readonly ["house.pape.fledgling/context-hint"]?: unknown })[
        "house.pape.fledgling/context-hint"
      ];
    }
  }

  return undefined;
}

/** Wraps a non-object value so it can be sent through ACP raw object fields. */
export function toRawObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}
