import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface StreamPart {
  readonly type: "text-delta";
  readonly text: string;
}

interface ControlledStream {
  readonly result: { readonly fullStream: AsyncIterable<StreamPart> };
  readonly release: () => void;
}

describe("FledglingAgent prompt cancellation", () => {
  const originalConfig = process.env.FLEDGLING_CONFIG;
  const originalSessionFile = process.env.FLEDGLING_SESSION_FILE;
  let tempDir: string | undefined;

  afterEach(async () => {
    restoreEnv("FLEDGLING_CONFIG", originalConfig);
    restoreEnv("FLEDGLING_SESSION_FILE", originalSessionFile);
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
    vi.doUnmock("./mcp-session-tools.js");
    vi.resetModules();

    const cleanupDir = tempDir;
    tempDir = undefined;
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
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

  async function createTestAgent(): Promise<{
    readonly agent: import("./agent.js").FledglingAgent;
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly streamText: ReturnType<typeof vi.fn>;
  }> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-prompt-test-"));
    process.env.FLEDGLING_CONFIG = path.join(tempDir, "missing-config.json");
    const sessionFile = path.join(tempDir, "session.jsonl");
    process.env.FLEDGLING_SESSION_FILE = sessionFile;

    const streamText = vi.fn();
    vi.doMock("ai", () => ({
      stepCountIs: vi.fn(() => ({ type: "step-count" })),
      streamText
    }));
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: vi.fn(() => ({
        chat: vi.fn(() => ({ provider: "chat" })),
        responses: vi.fn(() => ({ provider: "responses" }))
      }))
    }));
    vi.doMock("./mcp-session-tools.js", () => ({
      createSessionTools: vi.fn(async () => ({ mcpClients: [], tools: {} }))
    }));

    const { FledglingAgent } = await import("./agent.js");
    const agent = new FledglingAgent({
      sessionUpdate: vi.fn(async () => {})
    } as never);
    const session = await agent.newSession({ cwd: tempDir, mcpServers: [] });

    return { agent, sessionId: session.sessionId, sessionFile, streamText };
  }
});

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

async function loadStoredMessages(sessionFile: string): Promise<[string, string][]> {
  const raw = await readFile(sessionFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { readonly type: string; readonly text?: string })
    .filter((event) => event.type === "message.user" || event.type === "message.assistant")
    .map((event) => [event.type, event.text ?? ""]);
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
