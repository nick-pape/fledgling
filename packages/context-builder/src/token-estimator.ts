import type { ContextMessage, SessionEvent } from "@fledgling/common";

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: ContextMessage): number {
  return estimateTextTokens(message.content) + 4;
}

export function estimateMessagesTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

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
