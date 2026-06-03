import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@fledgling/common";
import { SessionStore } from "@fledgling/session-log";

import type { FledglingAgent, FledglingAgentDependencies } from "./agent.js";

type StreamPart =
  | {
      readonly type: "text-delta";
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly output: unknown;
    }
  | {
      readonly type: "tool-error";
      readonly toolCallId: string;
      readonly error: unknown;
    };

interface ControlledStream {
  readonly result: { readonly fullStream: AsyncIterable<StreamPart> };
  readonly release: () => void;
}

let tempDir: string | undefined;

describe("FledglingAgent prompt cancellation", () => {
  const originalConfig = process.env.FLEDGLING_CONFIG;
  const originalSessionFile = process.env.FLEDGLING_SESSION_FILE;

  afterEach(async () => {
    restoreEnv("FLEDGLING_CONFIG", originalConfig);
    restoreEnv("FLEDGLING_SESSION_FILE", originalSessionFile);

    const cleanupDir = tempDir;
    tempDir = undefined;
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  });

  it("streams text responses and persists user and assistant messages", async () => {
    const { agent, sessionId, streamText, sessionFile, sessionUpdates } = await createTestAgent();
    streamText.mockReturnValueOnce(createImmediateStream([{ type: "text-delta", text: "hello" }]));

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    expect(sessionUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" }
        }
      }
    ]);
    expect(await loadStoredEvents(sessionFile)).toEqual([
      expect.objectContaining({ type: "session.created" }),
      expect.objectContaining({ type: "message.user", text: "hi" }),
      expect.objectContaining({ type: "message.assistant", text: "hello" })
    ]);
  });

  it("emits and persists tool calls, tool results, and tool errors", async () => {
    const { agent, sessionId, streamText, sessionFile, sessionUpdates } = await createTestAgent();
    streamText.mockReturnValueOnce(
      createImmediateStream([
        { type: "tool-call", toolCallId: "call-1", toolName: "workspace_read", input: { path: "README.md" } },
        { type: "tool-result", toolCallId: "call-1", output: { content: "ok" } },
        { type: "tool-call", toolCallId: "call-2", toolName: "workspace_write", input: { path: "x" } },
        { type: "tool-error", toolCallId: "call-2", error: new Error("write failed") }
      ])
    );

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "use tools" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    expect(sessionUpdates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update"
    ]);
    expect(await loadStoredEventTypes(sessionFile)).toEqual([
      "session.created",
      "message.user",
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
      "message.assistant"
    ]);
    expect((await loadStoredEvents(sessionFile))[3]).toEqual(
      expect.objectContaining({ type: "tool.result", toolName: "workspace_read", status: "completed" })
    );
    expect((await loadStoredEvents(sessionFile))[5]).toEqual(
      expect.objectContaining({ type: "tool.result", toolName: "workspace_write", status: "failed" })
    );
  });

  it("normalizes model start failures into diagnostics and durable errors", async () => {
    const { agent, sessionId, streamText, sessionFile, sessionUpdates } = await createTestAgent();
    streamText.mockImplementationOnce(() => {
      throw new Error("\u001B[31mstart\tfailed\nwith\u0007 sk-secret123456");
    });

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).rejects.toThrow(
      "Fledgling model start failed: start failed with sk-[redacted]"
    );

    expect(sessionUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "\n\n[Fledgling error: model start failed. start failed with sk-[redacted]]"
          }
        }
      }
    ]);
    expect(await loadStoredEvents(sessionFile)).toEqual([
      expect.objectContaining({ type: "session.created" }),
      expect.objectContaining({ type: "message.user", text: "hi" }),
      expect.objectContaining({
        type: "session.error",
        kind: "model_start_failed",
        phase: "model_start",
        message: "start failed with sk-[redacted]",
        recoverable: true,
        assistantTextPersisted: false,
        errorName: "Error"
      })
    ]);
  });

  it("persists streamed assistant text before durable stream errors", async () => {
    const { agent, sessionId, streamText, sessionFile, sessionUpdates } = await createTestAgent();
    streamText.mockReturnValueOnce(createFailingStream([{ type: "text-delta", text: "partial" }], new Error("boom")));

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).rejects.toThrow(
      "Fledgling model stream failed: boom"
    );

    expect(sessionUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "partial" }
        }
      },
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "\n\n[Fledgling error: model stream failed. boom]"
          }
        }
      }
    ]);
    expect(await loadStoredEvents(sessionFile)).toEqual([
      expect.objectContaining({ type: "session.created" }),
      expect.objectContaining({ type: "message.user", text: "hi" }),
      expect.objectContaining({ type: "message.assistant", text: "partial" }),
      expect.objectContaining({
        type: "session.error",
        kind: "model_stream_failed",
        phase: "model_stream",
        message: "boom",
        assistantTextPersisted: true
      })
    ]);
  });

  it("does not persist an empty assistant message when streams fail before text", async () => {
    const { agent, sessionId, streamText, sessionFile, sessionUpdates } = await createTestAgent();
    streamText.mockReturnValueOnce(createFailingStream([], new Error("stream failed")));

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).rejects.toThrow(
      "Fledgling model stream failed: stream failed"
    );

    expect(sessionUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "\n\n[Fledgling error: model stream failed. stream failed]"
          }
        }
      }
    ]);
    expect(await loadStoredEventTypes(sessionFile)).toEqual(["session.created", "message.user", "session.error"]);
    expect((await loadStoredEvents(sessionFile))[2]).toEqual(
      expect.objectContaining({
        type: "session.error",
        kind: "model_stream_failed",
        assistantTextPersisted: false
      })
    );
  });

  it("rejects unknown sessions with a stable sanitized error and no log write", async () => {
    const { agent, sessionFile } = await createTestAgent();

    await expect(agent.prompt({ sessionId: "missing", prompt: [{ type: "text", text: "hi" }] })).rejects.toThrow(
      "Unknown ACP session: missing"
    );

    expect(await loadStoredEventTypes(sessionFile)).toEqual(["session.created"]);
  });

  it("runs later prompts after a normalized model failure", async () => {
    const { agent, sessionId, streamText, sessionFile } = await createTestAgent();
    streamText
      .mockImplementationOnce(() => {
        throw new Error("start failed");
      })
      .mockReturnValueOnce(createImmediateStream([{ type: "text-delta", text: "second" }]));

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] })).rejects.toThrow(
      "Fledgling model start failed: start failed"
    );
    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    expect(await loadStoredMessages(sessionFile)).toEqual([
      ["message.user", "one"],
      ["message.user", "two"],
      ["message.assistant", "second"]
    ]);
  });

  it("queues overlapping prompts for the same session", async () => {
    const { agent, sessionId, streamText, sessionFile } = await createTestAgent();
    const firstStream = createControlledStream([{ type: "text-delta", text: "first" }]);
    const secondStream = createControlledStream([{ type: "text-delta", text: "second" }]);
    streamText.mockReturnValueOnce(firstStream.result).mockReturnValueOnce(secondStream.result);

    const firstPrompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await waitFor(() => expect(streamText).toHaveBeenCalledTimes(1));

    const secondPrompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] });
    await flushPromises();
    expect(streamText).toHaveBeenCalledTimes(1);

    firstStream.release();
    await expect(firstPrompt).resolves.toEqual({ stopReason: "end_turn" });
    await waitFor(() => expect(streamText).toHaveBeenCalledTimes(2));

    secondStream.release();
    await expect(secondPrompt).resolves.toEqual({ stopReason: "end_turn" });

    const messages = await loadStoredMessages(sessionFile);
    expect(messages).toEqual([
      ["message.user", "one"],
      ["message.assistant", "first"],
      ["message.user", "two"],
      ["message.assistant", "second"]
    ]);
  });

  it("cancels the active prompt and then runs the queued prompt", async () => {
    const { agent, sessionId, streamText } = await createTestAgent();
    streamText
      .mockImplementationOnce(({ abortSignal }: { readonly abortSignal: AbortSignal }) =>
        createAbortableStream(abortSignal)
      )
      .mockReturnValueOnce(createImmediateStream([{ type: "text-delta", text: "second" }]));

    const firstPrompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await waitFor(() => expect(streamText).toHaveBeenCalledTimes(1));

    const secondPrompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] });
    await agent.cancel({ sessionId });

    await expect(firstPrompt).resolves.toEqual({ stopReason: "cancelled" });
    await waitFor(() => expect(streamText).toHaveBeenCalledTimes(2));
    await expect(secondPrompt).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("cancels a queued prompt if its session is replaced before it starts", async () => {
    const { agent, sessionId, streamText, sessionFile, tempDir } = await createTestAgent();
    streamText.mockImplementationOnce(({ abortSignal }: { readonly abortSignal: AbortSignal }) =>
      createAbortableStream(abortSignal)
    );

    const firstPrompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "one" }] });
    await waitFor(() => expect(streamText).toHaveBeenCalledTimes(1));

    const secondPrompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "two" }] });
    await agent.loadSession({ sessionId, cwd: tempDir, mcpServers: [] });

    await expect(firstPrompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(secondPrompt).resolves.toEqual({ stopReason: "cancelled" });
    expect(streamText).toHaveBeenCalledTimes(1);

    const messages = await loadStoredMessages(sessionFile);
    expect(messages).toEqual([["message.user", "one"]]);
  });

  it("replays stored user and assistant messages when loading a session", async () => {
    const { agent, sessionId, sessionStore, sessionUpdates, tempDir } = await createTestAgent();
    await sessionStore.append({
      ...sessionStore.createEventBase(sessionId),
      type: "message.user",
      text: "previous user"
    });
    await sessionStore.append({
      ...sessionStore.createEventBase(sessionId),
      type: "message.assistant",
      text: "previous assistant"
    });

    await agent.loadSession({ sessionId, cwd: tempDir, mcpServers: [] });

    expect(sessionUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "previous user" }
        }
      },
      {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "previous assistant" }
        }
      }
    ]);
  });

  it("rejects session creation when injected tool setup fails", async () => {
    const { FledglingAgent } = await import("./agent.js");
    const sessionStore = await createTempSessionStore();
    const agent = new FledglingAgent(createFakeConnection() as never, {
      createSessionTools: vi.fn(async () => {
        throw new Error("setup failed");
      }),
      sessionStore: sessionStore.store,
      runModelTurn: vi.fn()
    });

    await expect(agent.newSession({ cwd: sessionStore.tempDir, mcpServers: [] })).rejects.toThrow("setup failed");
  });

  async function createTestAgent(): Promise<{
    readonly agent: FledglingAgent;
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly sessionStore: SessionStore;
    readonly sessionUpdates: FakeSessionUpdate[];
    readonly tempDir: string;
    readonly streamText: ReturnType<typeof vi.fn>;
  }> {
    const { store: sessionStore, sessionFile, tempDir: createdTempDir } = await createTempSessionStore();
    const sessionUpdates: FakeSessionUpdate[] = [];
    const streamText = vi.fn();
    const { FledglingAgent } = await import("./agent.js");
    const agent = new FledglingAgent(createFakeConnection(sessionUpdates) as never, {
      createSessionTools: vi.fn(async () => ({ mcpClients: [], tools: {} })),
      sessionStore,
      runModelTurn: streamText
    } satisfies FledglingAgentDependencies);
    const session = await agent.newSession({ cwd: createdTempDir, mcpServers: [] });

    return {
      agent,
      sessionId: session.sessionId,
      sessionFile,
      sessionStore,
      sessionUpdates,
      tempDir: createdTempDir,
      streamText
    };
  }
});

interface FakeSessionUpdate {
  readonly sessionId: string;
  readonly update: {
    readonly sessionUpdate: string;
    readonly [key: string]: unknown;
  };
}

function createFakeConnection(sessionUpdates: FakeSessionUpdate[] = []): { sessionUpdate(params: FakeSessionUpdate): Promise<void> } {
  return {
    async sessionUpdate(params: FakeSessionUpdate): Promise<void> {
      sessionUpdates.push(params);
    }
  };
}

async function createTempSessionStore(): Promise<{
  readonly store: SessionStore;
  readonly sessionFile: string;
  readonly tempDir: string;
}> {
  const createdTempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-prompt-test-"));
  tempDir = createdTempDir;
  process.env.FLEDGLING_CONFIG = path.join(createdTempDir, "missing-config.json");
  const sessionFile = path.join(createdTempDir, "session.jsonl");
  process.env.FLEDGLING_SESSION_FILE = sessionFile;
  return { store: new SessionStore(createdTempDir, sessionFile), sessionFile, tempDir: createdTempDir };
}

function createControlledStream(parts: readonly StreamPart[]): ControlledStream {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    result: {
      fullStream: (async function* () {
        await gate;
        yield* parts;
      })()
    },
    release
  };
}

function createAbortableStream(abortSignal: AbortSignal): { readonly fullStream: AsyncIterable<StreamPart> } {
  return {
    fullStream: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<StreamPart>> {
            if (abortSignal.aborted) {
              throw new Error("aborted");
            }

            await new Promise<void>((_resolve, reject) => {
              abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
            return { done: true, value: undefined };
          }
        };
      }
    }
  };
}

function createImmediateStream(parts: readonly StreamPart[]): { readonly fullStream: AsyncIterable<StreamPart> } {
  return {
    fullStream: (async function* () {
      yield* parts;
    })()
  };
}

function createFailingStream(
  parts: readonly StreamPart[],
  error: unknown
): { readonly fullStream: AsyncIterable<StreamPart> } {
  return {
    fullStream: (async function* () {
      yield* parts;
      throw error;
    })()
  };
}

async function loadStoredMessages(sessionFile: string): Promise<[string, string][]> {
  return (await loadStoredEvents(sessionFile))
    .filter((event) => event.type === "message.user" || event.type === "message.assistant")
    .map((event) => [event.type, event.text]);
}

async function loadStoredEventTypes(sessionFile: string): Promise<string[]> {
  return (await loadStoredEvents(sessionFile)).map((event) => event.type);
}

async function loadStoredEvents(sessionFile: string): Promise<SessionEvent[]> {
  const raw = await readFile(sessionFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      if (Date.now() > deadline) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
