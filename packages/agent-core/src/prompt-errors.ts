import type { SessionErrorEvent } from "@fledgling/common";

/** Session error kind used for prompt failures. */
export type PromptErrorKind = SessionErrorEvent["kind"];

/** Session error phase used for prompt failures. */
export type PromptErrorPhase = SessionErrorEvent["phase"];

/** Sanitized error details persisted for a failed prompt. */
export interface NormalizedPromptError {
  /** Fledgling session error kind. */
  readonly kind: PromptErrorKind;

  /** Prompt lifecycle phase where the error occurred. */
  readonly phase: PromptErrorPhase;

  /** Sanitized human-readable error message. */
  readonly message: string;

  /** Whether a later prompt may continue the session. */
  readonly recoverable: boolean;

  /** Sanitized original error name, when available. */
  readonly errorName: string | undefined;

  /** Sanitized original error code, when available. */
  readonly errorCode: string | undefined;
}

/** Normalizes an unknown prompt failure into persisted session error details. */
export function normalizePromptError(
  error: unknown,
  kind: PromptErrorKind,
  phase: PromptErrorPhase
): NormalizedPromptError {
  return {
    kind,
    phase,
    message: sanitizeErrorMessage(extractErrorMessage(error)),
    recoverable: true,
    errorName: extractErrorName(error),
    errorCode: extractErrorCode(error)
  };
}

/** Creates the RPC error surfaced to ACP clients for model prompt failures. */
export function createPromptRpcError(error: unknown, phase: "model_start" | "model_stream"): Error {
  const normalized = normalizePromptError(
    error,
    phase === "model_start" ? "model_start_failed" : "model_stream_failed",
    phase
  );
  return new Error(`Fledgling ${formatPromptErrorKind(normalized.kind)}: ${normalized.message}`);
}

/** Formats a prompt error kind for user-visible text. */
export function formatPromptErrorKind(kind: PromptErrorKind): string {
  switch (kind) {
    case "model_start_failed":
      return "model start failed";

    case "model_stream_failed":
      return "model stream failed";

    case "prompt_cleanup_failed":
      return "prompt cleanup failed";
  }
}

/** Removes unsafe control characters and redacts common secret forms from an error message. */
export function sanitizeErrorMessage(message: string): string {
  const withoutControlCharacters = replaceControlCharacters(stripAnsiEscapeSequences(message));
  const normalized = withoutControlCharacters.replace(/\s+/g, " ").trim() || "Unknown error";
  const redacted = normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]");

  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return "Unknown error";
}

function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }

  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { readonly name?: unknown }).name;
    return typeof name === "string" ? sanitizeErrorMessage(name) : undefined;
  }

  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    return sanitizeErrorMessage(String(code));
  }

  return undefined;
}

function stripAnsiEscapeSequences(message: string): string {
  let stripped = "";
  for (let index = 0; index < message.length; index++) {
    const code = message.charCodeAt(index);
    if (code !== 0x1b) {
      stripped += message[index];
      continue;
    }

    const next = message.charCodeAt(index + 1);
    if (next === 0x5b) {
      index += 2;
      while (index < message.length) {
        const sequenceCode = message.charCodeAt(index);
        if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) {
          break;
        }

        index++;
      }
      continue;
    }

    if (next >= 0x40 && next <= 0x5f) {
      index++;
    }
  }

  return stripped;
}

function replaceControlCharacters(message: string): string {
  let replaced = "";
  for (let index = 0; index < message.length; index++) {
    const code = message.charCodeAt(index);
    replaced += isUnsafeControlCharacter(code) ? " " : message[index];
  }

  return replaced;
}

function isUnsafeControlCharacter(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}
