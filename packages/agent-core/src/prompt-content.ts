import type { PromptRequest } from "@agentclientprotocol/sdk";
import type {
  FledglingImageContentPart,
  FledglingMessageContent,
  FledglingMessageContentPart,
  FledglingResourceLinkContentPart
} from "@fledgling/common";
import type { CoreMessage, UserContent } from "ai";

/** Options that control ACP prompt content conversion. */
export interface PromptContentOptions {
  /** Whether image prompt blocks should be forwarded to the model as image parts. */
  readonly imageInput?: boolean;
}

/** ACP prompt content converted for persistence, replay, and model input. */
export interface ConvertedPromptContent {
  /** Deterministic text projection for display, replay, and fallback model input. */
  readonly text: string;

  /** Normalized content persisted in the session event log. */
  readonly content: FledglingMessageContent;

  /** Content to send to the model for the current turn. */
  readonly modelContent: UserContent;
}

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

        if (typeof part === "object") {
          return modelContentPartToText(part);
        }

        return JSON.stringify(part);
      })
      .join("\n");
  }

  return JSON.stringify(content);
}

/** Converts an ACP prompt request into persisted content and model input. */
export function convertPromptContent(
  params: PromptRequest,
  options: PromptContentOptions = {}
): ConvertedPromptContent {
  const content = normalizePromptContent(params.prompt);
  const text = renderPromptContent(content);
  return {
    text,
    content,
    modelContent: toModelContent(content, text, options)
  };
}

/** Extracts user prompt text from an ACP prompt request. */
export function extractPromptText(params: PromptRequest): string {
  return convertPromptContent(params).text;
}

/** Converts persisted message content into model content. */
export function persistedContentToModelContent(
  content: FledglingMessageContent | undefined,
  fallbackText: string,
  options: PromptContentOptions = {}
): UserContent {
  return toModelContent(content ?? fallbackText, fallbackText, options);
}

/** Renders persisted message content as deterministic fallback text. */
export function renderPromptContent(content: FledglingMessageContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content.map(renderPromptContentPart).join("\n");
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

function normalizePromptContent(prompt: PromptRequest["prompt"]): FledglingMessageContent {
  return prompt.map(normalizePromptPart);
}

function normalizePromptPart(part: PromptRequest["prompt"][number]): FledglingMessageContentPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };

    case "resource_link":
      return {
        type: "resource_link",
        uri: part.uri,
        name: part.name,
        title: part.title ?? undefined,
        description: part.description ?? undefined,
        mimeType: part.mimeType ?? undefined,
        size: part.size ?? undefined
      };

    case "image":
      return {
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
        uri: part.uri ?? undefined
      };

    default:
      return {
        type: "unsupported",
        originalType: readBlockType(part),
        raw: part
      };
  }
}

function toModelContent(
  content: FledglingMessageContent,
  fallbackText: string,
  options: PromptContentOptions
): UserContent {
  if (typeof content === "string") {
    return content;
  }

  const parts = content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }

    if (part.type === "image" && options.imageInput) {
      return { type: "image" as const, image: part.data, mediaType: part.mimeType };
    }

    return { type: "text" as const, text: renderPromptContentPart(part) };
  });

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }

  return parts.length > 0 ? parts : fallbackText;
}

function renderPromptContentPart(part: FledglingMessageContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;

    case "resource_link":
      return renderResourceLink(part);

    case "image":
      return renderImage(part);

    case "unsupported":
      return `[Unsupported ACP content block${part.originalType ? `: ${part.originalType}` : ""}] ${JSON.stringify(part.raw)}`;
  }
}

function renderResourceLink(part: FledglingResourceLinkContentPart): string {
  const label = part.title ?? part.name;
  const details = [part.mimeType, part.size === undefined ? undefined : `${part.size} bytes`]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  const suffix = details ? ` (${details})` : "";
  const description = part.description ? ` - ${part.description}` : "";
  return `[Resource link: ${label} <${part.uri}>${suffix}]${description}`;
}

function renderImage(part: FledglingImageContentPart): string {
  const source = part.uri ? `, uri: ${part.uri}` : "";
  return `[Image: ${part.mimeType}${source}, base64 chars: ${part.data.length}]`;
}

function readBlockType(part: unknown): string | undefined {
  if (part && typeof part === "object" && "type" in part && typeof part.type === "string") {
    return part.type;
  }

  return undefined;
}

function modelContentPartToText(part: object): string {
  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  if ("type" in part && part.type === "image") {
    const mediaType = "mediaType" in part && typeof part.mediaType === "string" ? part.mediaType : "unknown";
    const image = "image" in part ? part.image : undefined;
    const length = typeof image === "string" ? `, base64 chars: ${image.length}` : "";
    return `[Image: ${mediaType}${length}]`;
  }

  if ("type" in part && part.type === "file") {
    const mediaType = "mediaType" in part && typeof part.mediaType === "string" ? part.mediaType : "unknown";
    const filename = "filename" in part && typeof part.filename === "string" ? `, filename: ${part.filename}` : "";
    const data = "data" in part ? part.data : undefined;
    const length = typeof data === "string" ? `, base64 chars: ${data.length}` : "";
    return `[File: ${mediaType}${filename}${length}]`;
  }

  return JSON.stringify(part);
}
