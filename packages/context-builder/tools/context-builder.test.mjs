#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  buildCompactedContext,
  buildContext,
  compactContext,
  eventsToMessages,
  prepareCompaction,
  pruneOldVolatileEvents
} from "../lib/index.js";

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
];

assert.deepEqual(eventsToMessages(events), [
  { role: "user", content: "Please check the repo." },
  { role: "assistant", content: "The repo is clean now." },
  { role: "user", content: "Now add resume." },
  { role: "assistant", content: "I will add resume." }
]);

const replay = buildContext(events, { mode: "replay" });
assert.equal(replay.events.length, events.length);
assert.equal(replay.dropped.length, 0);
assert.deepEqual(replay.messages, [
  { role: "user", content: "Please check the repo." },
  { role: "assistant", content: "The repo is clean now." },
  { role: "user", content: "Now add resume." },
  { role: "assistant", content: "I will add resume." }
]);

const pruned = pruneOldVolatileEvents(events, {
  keepLatestToolResultsPerGroup: 1,
  keepLatestToolCallsPerGroup: 1
});
assert.deepEqual(
  pruned.dropped.map((drop) => drop.eventId).sort(),
  ["status-result-1"]
);
assert.ok(pruned.events.some((event) => event.eventId === "status-result-2"));
assert.ok(pruned.events.some((event) => event.eventId === "user-1"));
assert.ok(pruned.events.some((event) => event.eventId === "assistant-1"));

const prepared = prepareCompaction(events, {
  keepLatestTurns: 1,
  prune: { keepLatestToolResultsPerGroup: 1, keepLatestToolCallsPerGroup: 1 }
});
assert.equal(prepared.needsCompaction, true);
assert.deepEqual(
  prepared.eventsToCompact.map((event) => event.eventId),
  ["created", "user-1", "status-call-1", "status-result-2", "assistant-1"]
);
assert.deepEqual(
  prepared.retainedEvents.map((event) => event.eventId),
  ["user-2", "assistant-2"]
);
assert.deepEqual(prepared.dropped.map((drop) => drop.eventId), ["status-result-1"]);

const assembled = buildCompactedContext({
  summary: "Compacted continuity summary.",
  retainedEvents: prepared.retainedEvents
});
assert.deepEqual(assembled.messages, [
  { role: "system", content: "Compacted continuity summary." },
  { role: "user", content: "Now add resume." },
  { role: "assistant", content: "I will add resume." }
]);

const limited = prepareCompaction(events, {
  keepLatestTurns: 1,
  maxCompactionInputTokens: 8
});
assert.ok(limited.eventsToCompact.length < prepared.eventsToCompact.length);
assert.ok(limited.dropped.some((drop) => drop.reason === "compaction_input_over_token_budget"));

let compactorRequest;
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
assert.deepEqual(
  compactorRequest.events.map((event) => event.eventId),
  ["created", "user-1", "status-call-1", "status-result-2", "assistant-1"]
);
assert.equal(compactorRequest.targetTokens, 200);
assert.equal(compactorRequest.instructions, "custom compaction instructions");
assert.equal(compacted.summary, "Summary for created,user-1,status-call-1,status-result-2,assistant-1.");
assert.deepEqual(compacted.messages, [
  { role: "system", content: "Summary for created,user-1,status-call-1,status-result-2,assistant-1." },
  { role: "user", content: "Now add resume." },
  { role: "assistant", content: "I will add resume." }
]);

let unexpectedCompactorCall = false;
const noCompactionNeeded = await compactContext(
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
assert.equal(unexpectedCompactorCall, false);
assert.equal(noCompactionNeeded.summary, undefined);
assert.deepEqual(noCompactionNeeded.messages, [
  { role: "user", content: "Only current turn." },
  { role: "assistant", content: "No summary needed." }
]);

console.log("context-builder ok");
