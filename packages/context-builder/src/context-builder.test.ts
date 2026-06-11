import { describe, expect, it } from "vitest";

import {
  buildCompactedContext,
  buildContext,
  compactContext,
  eventsToMessages,
  prepareCompaction,
  pruneOldVolatileEvents
} from "./index.js";

const base = {
  sessionId: "session-1",
  timestamp: "2026-06-01T00:00:00.000Z"
};

const events = [
  { ...base, eventId: "created", type: "session.created", cwd: "C:\\repo", mcpServers: [] },
  { ...base, eventId: "user-1", type: "message.user", text: "Please check the repo." },
  {
    ...base,
    eventId: "status-call-1",
    type: "tool.call",
    toolCallId: "status-1",
    toolName: "workspace_run_command",
    title: "git status",
    rawInput: { command: "git status" }
  },
  {
    ...base,
    eventId: "status-result-1",
    type: "tool.result",
    toolCallId: "status-1",
    toolName: "workspace_run_command",
    status: "completed",
    text: "old status",
    rawOutput: { structuredContent: { path: "git-status" } },
    contextHint: undefined
  },
  {
    ...base,
    eventId: "status-result-2",
    type: "tool.result",
    toolCallId: "status-2",
    toolName: "workspace_run_command",
    status: "completed",
    text: "new status",
    rawOutput: { structuredContent: { path: "git-status" } },
    contextHint: undefined
  },
  { ...base, eventId: "assistant-1", type: "message.assistant", text: "The repo is clean now." },
  { ...base, eventId: "user-2", type: "message.user", text: "Now add resume." },
  { ...base, eventId: "assistant-2", type: "message.assistant", text: "I will add resume." }
] as const;

describe("context builder", () => {
  it("builds replay context from user and assistant events", () => {
    const messages = [
      { role: "user", content: "Please check the repo." },
      { role: "assistant", content: "The repo is clean now." },
      { role: "user", content: "Now add resume." },
      { role: "assistant", content: "I will add resume." }
    ];

    expect(eventsToMessages(events)).toEqual(messages);
    expect(buildContext(events, { mode: "replay" })).toMatchObject({
      events: [...events],
      dropped: [],
      messages
    });
  });

  it("builds replay context from structured user content", () => {
    const richEvents = [
      {
        ...base,
        eventId: "rich-user",
        type: "message.user",
        text: "Look.\n[Resource link: README.md <file:///repo/README.md> (text/markdown)]\n[Image: image/png, base64 chars: 8]",
        content: [
          { type: "text", text: "Look." },
          {
            type: "resource_link",
            uri: "file:///repo/README.md",
            name: "README.md",
            title: undefined,
            description: undefined,
            mimeType: "text/markdown",
            size: undefined
          },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png", uri: undefined }
        ]
      }
    ] as const;

    expect(eventsToMessages(richEvents)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look." },
          { type: "text", text: "[Resource link: README.md <file:///repo/README.md> (text/markdown)]" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png", uri: undefined }
        ]
      }
    ]);
  });

  it("drops old volatile tool results before preparing compaction", () => {
    const pruned = pruneOldVolatileEvents(events, {
      keepLatestToolResultsPerGroup: 1,
      keepLatestToolCallsPerGroup: 1
    });

    expect(pruned.dropped.map((drop) => drop.eventId).sort()).toEqual(["status-result-1"]);
    expect(pruned.events.some((event) => event.eventId === "status-result-2")).toBe(true);
    expect(pruned.events.some((event) => event.eventId === "user-1")).toBe(true);
    expect(pruned.events.some((event) => event.eventId === "assistant-1")).toBe(true);
  });

  it("prepares compaction by retaining latest turns verbatim", () => {
    const prepared = prepareCompaction(events, {
      keepLatestTurns: 1,
      prune: { keepLatestToolResultsPerGroup: 1, keepLatestToolCallsPerGroup: 1 }
    });

    expect(prepared.needsCompaction).toBe(true);
    expect(prepared.eventsToCompact.map((event) => event.eventId)).toEqual([
      "created",
      "user-1",
      "status-call-1",
      "status-result-2",
      "assistant-1"
    ]);
    expect(prepared.retainedEvents.map((event) => event.eventId)).toEqual(["user-2", "assistant-2"]);
    expect(prepared.dropped.map((drop) => drop.eventId)).toEqual(["status-result-1"]);
  });

  it("assembles compacted context from summary and retained turns", () => {
    const prepared = prepareCompaction(events, { keepLatestTurns: 1 });
    const assembled = buildCompactedContext({
      summary: "Compacted continuity summary.",
      retainedEvents: prepared.retainedEvents
    });

    expect(assembled.messages).toEqual([
      { role: "system", content: "Compacted continuity summary." },
      { role: "user", content: "Now add resume." },
      { role: "assistant", content: "I will add resume." }
    ]);
  });

  it("limits compaction input without dropping retained turns", () => {
    const prepared = prepareCompaction(events, { keepLatestTurns: 1 });
    const limited = prepareCompaction(events, {
      keepLatestTurns: 1,
      maxCompactionInputTokens: 8
    });

    expect(limited.eventsToCompact.length).toBeLessThan(prepared.eventsToCompact.length);
    expect(limited.dropped.some((drop) => drop.reason === "compaction_input_over_token_budget")).toBe(true);
    expect(limited.retainedEvents.map((event) => event.eventId)).toEqual(["user-2", "assistant-2"]);
  });

  it("calls the injected async compactor when old events need compaction", async () => {
    let compactorRequest:
      | {
          readonly events: readonly { readonly eventId: string }[];
          readonly targetTokens: number | undefined;
          readonly instructions: string;
        }
      | undefined;

    const compacted = await compactContext(events, {
      keepLatestTurns: 1,
      targetTokens: 200,
      instructions: "custom compaction instructions",
      prune: { keepLatestToolResultsPerGroup: 1, keepLatestToolCallsPerGroup: 1 },
      compact: async (request) => {
        compactorRequest = request;
        return {
          summary: `Summary for ${request.events.map((event) => event.eventId).join(",")}.`
        };
      }
    });

    expect(compactorRequest?.events.map((event) => event.eventId)).toEqual([
      "created",
      "user-1",
      "status-call-1",
      "status-result-2",
      "assistant-1"
    ]);
    expect(compactorRequest?.targetTokens).toBe(200);
    expect(compactorRequest?.instructions).toBe("custom compaction instructions");
    expect(compacted.messages).toEqual([
      { role: "system", content: "Summary for created,user-1,status-call-1,status-result-2,assistant-1." },
      { role: "user", content: "Now add resume." },
      { role: "assistant", content: "I will add resume." }
    ]);
  });

  it("does not call the compactor when only retained turns remain", async () => {
    let unexpectedCompactorCall = false;
    const result = await compactContext(
      [
        { ...base, eventId: "only-user", type: "message.user", text: "Only current turn." },
        { ...base, eventId: "only-assistant", type: "message.assistant", text: "No summary needed." }
      ],
      {
        keepLatestTurns: 1,
        compact: async () => {
          unexpectedCompactorCall = true;
          return { summary: "should not be used" };
        }
      }
    );

    expect(unexpectedCompactorCall).toBe(false);
    expect(result.summary).toBeUndefined();
    expect(result.messages).toEqual([
      { role: "user", content: "Only current turn." },
      { role: "assistant", content: "No summary needed." }
    ]);
  });
});
