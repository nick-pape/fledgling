import type { ContextMessage, SessionEvent } from "@fledgling/common";

/**
 * Estimates tokens for plain text using a character-count heuristic.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimates tokens for a chat message, including a small per-message overhead.
 */
export function estimateMessageTokens(message: ContextMessage): number {
  return estimateTextTokens(message.content) + 4;
}

/**
 * Estimates total tokens for a sequence of chat messages.
 */
export function estimateMessagesTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * Estimates tokens for a session event using event-type-specific overheads.
 */
export function estimateEventTokens(event: SessionEvent): number {
  switch (event.type) {
    case "message.user":
    case "message.assistant":
      return estimateTextTokens(event.text) + 4;

    case "tool.call":
      return estimateTextTokens(`${event.toolName} ${JSON.stringify(event.rawInput)}`) + 8;

    case "tool.result":
      return estimateTextTokens(event.text) + 8;

    default:
      return estimateTextTokens(JSON.stringify(event)) + 4;
  }
}
