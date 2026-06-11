import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

import type { SessionEvent } from "@fledgling/common";
import { FileSystemSessionManager } from "@fledgling/session-file-system";

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

  it("advertises only the minimum supported ACP agent capabilities", async () => {
    const { agent } = await createTestAgent();

    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never);

    expect(typeof response.protocolVersion).toBe("number");
    expect(response.agentCapabilities).toEqual({
      loadSession: true,
      mcpCapabilities: {
        http: true,
        sse: true
      }
    });
    expect(response.authMethods).toEqual([]);
  });

  it("rejects unsupported ACP authentication methods", async () => {
    const { agent } = await createTestAgent();

    await expect(agent.authenticate({ methodId: "token" })).rejects.toThrow(
      "Unsupported ACP authentication method: token"
    );
  });

  it("returns write mode as the default mode for new sessions", async () => {
    const { FledglingAgent } = await import("./agent.js");
    const { manager, tempDir: createdTempDir } = await createTempSessionManager();
    const agent = new FledglingAgent(createFakeConnection() as never, {
      toolProvider: {
        createSessionTools: vi.fn(async () => ({ clients: [], tools: {} }))
      },
      sessionManager: manager,
      modelTurnRunner: {
        runModelTurn: vi.fn()
      }
    });

    const response = await agent.newSession({ cwd: createdTempDir, mcpServers: [] });

    expect(typeof response.sessionId).toBe("string");
    expect(response).toEqual({
      sessionId: response.sessionId,
      modes: {
        currentModeId: "write",
        availableModes: [
          {
            id: "read",
            name: "Read",
            description: "Inspect the workspace without file mutations or command execution."
          },
          {
            id: "write",
            name: "Write",
            description: "Use all available workspace tools, including writes and command execution."
          }
        ]
      }
    });
  });

  it("sets session mode, emits a mode update, and persists the change", async () => {
    const { agent, sessionId, sessionFile, sessionUpdates } = await createTestAgent();

    await expect(agent.setSessionMode({ sessionId, modeId: "read" })).resolves.toEqual({});

    expect(sessionUpdates).toEqual([
      {
        sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "read"
        }
      }
    ]);
    expect(await loadStoredEvents(sessionFile)).toEqual([
      expect.objectContaining({ type: "session.created" }),
      expect.objectContaining({ type: "session.mode_changed", modeId: "read" })
    ]);
  });

  it("rejects unknown session mode requests", async () => {
    const { agent, sessionId } = await createTestAgent();

    await expect(agent.setSessionMode({ sessionId: "missing", modeId: "read" })).rejects.toThrow(
      "Unknown ACP session: missing"
    );
    await expect(agent.setSessionMode({ sessionId, modeId: "delete" })).rejects.toThrow(
      "Unsupported ACP session mode: delete"
    );
  });

  it("advertises image prompt capability only when configured", async () => {
    const { agent } = await createTestAgent({ promptContent: { imageInput: true } });
    const withoutImages = await createTestAgent();

    await expect(agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never)).resolves.toMatchObject({
      agentCapabilities: {
        promptCapabilities: {
          image: true
        }
      }
    });
    await expect(
      withoutImages.agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never)
    ).resolves.toMatchObject({
      agentCapabilities: {
        promptCapabilities: undefined
      }
    });
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

  it("preserves rich prompt content while forwarding supported image parts to the model", async () => {
    const { agent, sessionId, streamText, sessionFile } = await createTestAgent({
      promptContent: { imageInput: true }
    });
    streamText.mockReturnValueOnce(createImmediateStream([{ type: "text-delta", text: "seen" }]));

    await expect(
      agent.prompt({
        sessionId,
        prompt: [
          { type: "text", text: "Review these." },
          {
            type: "resource_link",
            uri: "file:///repo/README.md",
            name: "README.md",
            mimeType: "text/markdown"
          },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
        ]
      })
    ).resolves.toEqual({
      stopReason: "end_turn"
    });

    const [[modelRequest]] = streamText.mock.calls as [[{ readonly messages: readonly { readonly content: unknown }[] }]];
    expect(modelRequest.messages[0]?.content).toEqual([
      { type: "text", text: "Review these." },
      { type: "text", text: "[Resource link: README.md <file:///repo/README.md> (text/markdown)]" },
      { type: "image", image: "aW1hZ2U=", mediaType: "image/png" }
    ]);
    expect((await loadStoredEvents(sessionFile))[1]).toEqual(
      expect.objectContaining({
        type: "message.user",
        text: "Review these.\n[Resource link: README.md <file:///repo/README.md> (text/markdown)]\n[Image: image/png, base64 chars: 8]",
        content: [
          { type: "text", text: "Review these." },
          {
            type: "resource_link",
            uri: "file:///repo/README.md",
            name: "README.md",
            mimeType: "text/markdown"
          },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
        ]
      })
    );
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

  it("includes prior successful tool calls and results in later model turns", async () => {
    const { agent, sessionId, streamText } = await createTestAgent();
    const capturedMessages: unknown[] = [];
    streamText.mockImplementation((request: { readonly messages: unknown }) => {
      capturedMessages.push(JSON.parse(JSON.stringify(request.messages)));
      return capturedMessages.length === 1
        ? createImmediateStream([
            { type: "tool-call", toolCallId: "call-1", toolName: "workspace_read", input: { path: "README.md" } },
            { type: "tool-call", toolCallId: "call-2", toolName: "workspace_list", input: { path: "." } },
            { type: "tool-result", toolCallId: "call-1", output: { content: "read ok" } },
            { type: "tool-result", toolCallId: "call-2", output: { entries: ["README.md"] } },
            { type: "text-delta", text: "done" }
          ])
        : createImmediateStream([]);
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "inspect" }] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] });

    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "workspace_read", input: { path: "README.md" } },
          { type: "tool-call", toolCallId: "call-2", toolName: "workspace_list", input: { path: "." } }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "workspace_read",
            output: { type: "json", value: { content: "read ok" } }
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "workspace_list",
            output: { type: "json", value: { entries: ["README.md"] } }
          }
        ]
      },
      { role: "assistant", content: "done" },
      { role: "user", content: "continue" }
    ]);
  });

  it("includes prior failed tool results in later model turns", async () => {
    const { agent, sessionId, streamText } = await createTestAgent();
    const capturedMessages: unknown[] = [];
    streamText.mockImplementation((request: { readonly messages: unknown }) => {
      capturedMessages.push(JSON.parse(JSON.stringify(request.messages)));
      return capturedMessages.length === 1
        ? createImmediateStream([
            { type: "tool-call", toolCallId: "call-1", toolName: "workspace_write", input: { path: "x" } },
            { type: "tool-error", toolCallId: "call-1", error: new Error("write failed") }
          ])
        : createImmediateStream([]);
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "write" }] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "what failed" }] });

    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "write" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "workspace_write", input: { path: "x" } }]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "workspace_write",
            output: { type: "error-text", value: "write failed" }
          }
        ]
      },
      { role: "user", content: "what failed" }
    ]);
  });

  it("does not use ACP host filesystem or permission methods during prompt flow", async () => {
    const { manager: sessionManager, sessionFile, tempDir: createdTempDir } = await createTempSessionManager();
    const sessionUpdates: FakeSessionUpdate[] = [];
    const hostMethods = createFailingHostMethods();
    const streamText = vi.fn(() => createImmediateStream([{ type: "text-delta", text: "mcp-first" }]));
    const { FledglingAgent } = await import("./agent.js");
    const agent = new FledglingAgent(
      {
        ...createFakeConnection(sessionUpdates),
        ...hostMethods
      } as never,
      {
        toolProvider: {
          createSessionTools: vi.fn(async () => ({ clients: [], tools: {} }))
        },
        sessionManager,
        modelTurnRunner: {
          runModelTurn: streamText
        }
      } satisfies FledglingAgentDependencies
    );
    const session = await agent.newSession({ cwd: createdTempDir, mcpServers: [] });

    await expect(agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    expect(hostMethods.requestPermission).not.toHaveBeenCalled();
    expect(hostMethods.readTextFile).not.toHaveBeenCalled();
    expect(hostMethods.writeTextFile).not.toHaveBeenCalled();
    expect(await loadStoredMessages(sessionFile)).toEqual([
      ["message.user", "hi"],
      ["message.assistant", "mcp-first"]
    ]);
  });

  it("filters known mutating workspace tools in read mode", async () => {
    const tools = createNamedTools([
      "workspace_read_file",
      "workspace_list_directory",
      "workspace_search_text",
      "workspace_write_file",
      "workspace_replace_range",
      "workspace_run_command",
      "workspace.read_file",
      "workspace.write_file",
      "workspace.replace_range",
      "workspace.run_command",
      "external_mutate"
    ]);
    const { agent, sessionId, streamText } = await createTestAgent({ tools });
    streamText.mockReturnValueOnce(createImmediateStream([]));

    await agent.setSessionMode({ sessionId, modeId: "read" });
    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "inspect" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    const [[modelRequest]] = streamText.mock.calls as [[{ readonly tools: ToolSet }]];
    expect(Object.keys(modelRequest.tools).sort()).toEqual([
      "external_mutate",
      "workspace.read_file",
      "workspace_list_directory",
      "workspace_read_file",
      "workspace_search_text"
    ]);
  });

  it("keeps all tools in write mode", async () => {
    const tools = createNamedTools(["workspace_read_file", "workspace_write_file", "workspace_run_command"]);
    const { agent, sessionId, streamText } = await createTestAgent({ tools });
    streamText.mockReturnValueOnce(createImmediateStream([]));

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "change" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    const [[modelRequest]] = streamText.mock.calls as [[{ readonly tools: ToolSet }]];
    expect(Object.keys(modelRequest.tools).sort()).toEqual([
      "workspace_read_file",
      "workspace_run_command",
      "workspace_write_file"
    ]);
  });

  it("restores persisted mode when loading a session", async () => {
    const tools = createNamedTools(["workspace_read_file", "workspace_write_file"]);
    const { agent, sessionId, sessionManager, streamText, tempDir } = await createTestAgent({ tools });
    streamText.mockReturnValueOnce(createImmediateStream([]));
    await sessionManager.appendEvent({
      ...sessionManager.createEventBase(sessionId),
      type: "session.mode_changed",
      modeId: "read"
    });

    const loadResponse = await agent.loadSession({ sessionId, cwd: tempDir, mcpServers: [] });
    expect(loadResponse.modes?.currentModeId).toBe("read");
    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "inspect" }] })).resolves.toEqual({
      stopReason: "end_turn"
    });

    const [[modelRequest]] = streamText.mock.calls as [[{ readonly tools: ToolSet }]];
    expect(Object.keys(modelRequest.tools)).toEqual(["workspace_read_file"]);
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

  it("keeps streamed tool history available after a durable stream error", async () => {
    const { agent, sessionId, streamText } = await createTestAgent();
    const capturedMessages: unknown[] = [];
    streamText.mockImplementation((request: { readonly messages: unknown }) => {
      capturedMessages.push(JSON.parse(JSON.stringify(request.messages)));
      return capturedMessages.length === 1
        ? createFailingStream(
            [
              { type: "tool-call", toolCallId: "call-1", toolName: "workspace_read", input: { path: "README.md" } },
              { type: "tool-result", toolCallId: "call-1", output: { content: "partial context" } },
              { type: "text-delta", text: "partial" }
            ],
            new Error("boom")
          )
        : createImmediateStream([]);
    });

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "inspect" }] })).rejects.toThrow(
      "Fledgling model stream failed: boom"
    );
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] });

    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "workspace_read", input: { path: "README.md" } }]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "workspace_read",
            output: { type: "json", value: { content: "partial context" } }
          }
        ]
      },
      { role: "assistant", content: "partial" },
      { role: "user", content: "continue" }
    ]);
  });

  it("falls back to text when tool output is not JSON-safe", async () => {
    const { agent, sessionId, streamText } = await createTestAgent();
    const capturedMessages: unknown[] = [];
    const circular: { self?: unknown } = {};
    circular.self = circular;
    streamText.mockImplementation((request: { readonly messages: unknown }) => {
      capturedMessages.push(JSON.parse(JSON.stringify(request.messages)));
      return capturedMessages.length === 1
        ? createImmediateStream([
            { type: "tool-call", toolCallId: "call-1", toolName: "workspace_read", input: { path: "README.md" } },
            { type: "tool-result", toolCallId: "call-1", output: circular }
          ])
        : createImmediateStream([]);
    });

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "inspect" }] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] });

    expect(capturedMessages[1]).toContainEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "workspace_read",
          output: { type: "json", value: "[object Object]" }
        }
      ]
    });
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
    const { agent, sessionId, sessionManager, sessionUpdates, tempDir } = await createTestAgent();
    await sessionManager.appendEvent({
      ...sessionManager.createEventBase(sessionId),
      type: "message.user",
      text: "previous user"
    });
    await sessionManager.appendEvent({
      ...sessionManager.createEventBase(sessionId),
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

  it("rebuilds rich user history from stored prompt content when loading a session", async () => {
    const { agent, sessionId, sessionManager, streamText, tempDir } = await createTestAgent({
      promptContent: { imageInput: true }
    });
    await sessionManager.appendEvent({
      ...sessionManager.createEventBase(sessionId),
      type: "message.user",
      text: "Describe this.\n[Image: image/png, base64 chars: 8]",
      content: [
        { type: "text", text: "Describe this." },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
      ]
    });
    await agent.loadSession({ sessionId, cwd: tempDir, mcpServers: [] });
    streamText.mockReturnValueOnce(createImmediateStream([]));

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "Continue." }] });

    const [[modelRequest]] = streamText.mock.calls as [[{ readonly messages: readonly { readonly content: unknown }[] }]];
    expect(modelRequest.messages[0]?.content).toEqual([
      { type: "text", text: "Describe this." },
      { type: "image", image: "aW1hZ2U=", mediaType: "image/png" }
    ]);
  });

  it("rejects session creation when injected tool setup fails", async () => {
    const { FledglingAgent } = await import("./agent.js");
    const sessionStore = await createTempSessionManager();
    const agent = new FledglingAgent(createFakeConnection() as never, {
      toolProvider: {
        createSessionTools: vi.fn(async () => {
          throw new Error("setup failed");
        })
      },
      sessionManager: sessionStore.manager,
      modelTurnRunner: {
        runModelTurn: vi.fn()
      }
    });

    await expect(agent.newSession({ cwd: sessionStore.tempDir, mcpServers: [] })).rejects.toThrow("setup failed");
  });

  async function createTestAgent(
    options: {
      readonly tools?: ToolSet;
      readonly promptContent?: FledglingAgentDependencies["promptContent"];
    } = {}
  ): Promise<{
    readonly agent: FledglingAgent;
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly sessionManager: FileSystemSessionManager;
    readonly sessionUpdates: FakeSessionUpdate[];
    readonly tempDir: string;
    readonly streamText: ReturnType<typeof vi.fn>;
  }> {
    const { manager: sessionManager, sessionFile, tempDir: createdTempDir } = await createTempSessionManager();
    const sessionUpdates: FakeSessionUpdate[] = [];
    const streamText = vi.fn();
    const { FledglingAgent } = await import("./agent.js");
    const agent = new FledglingAgent(createFakeConnection(sessionUpdates) as never, {
      toolProvider: {
        createSessionTools: vi.fn(async () => ({ clients: [], tools: options.tools ?? {} }))
      },
      sessionManager,
      modelTurnRunner: {
        runModelTurn: streamText
      },
      promptContent: options.promptContent
    } satisfies FledglingAgentDependencies);
    const session = await agent.newSession({ cwd: createdTempDir, mcpServers: [] });

    return {
      agent,
      sessionId: session.sessionId,
      sessionFile,
      sessionManager,
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

function createNamedTools(toolNames: readonly string[]): ToolSet {
  return Object.fromEntries(toolNames.map((toolName) => [toolName, {}])) as ToolSet;
}

function createFakeConnection(sessionUpdates: FakeSessionUpdate[] = []): { sessionUpdate(params: FakeSessionUpdate): Promise<void> } {
  return {
    async sessionUpdate(params: FakeSessionUpdate): Promise<void> {
      sessionUpdates.push(params);
    }
  };
}

function createFailingHostMethods(): {
  readonly requestPermission: ReturnType<typeof vi.fn>;
  readonly readTextFile: ReturnType<typeof vi.fn>;
  readonly writeTextFile: ReturnType<typeof vi.fn>;
} {
  return {
    requestPermission: vi.fn(async () => {
      throw new Error("ACP host permission should not be used");
    }),
    readTextFile: vi.fn(async () => {
      throw new Error("ACP host readTextFile should not be used");
    }),
    writeTextFile: vi.fn(async () => {
      throw new Error("ACP host writeTextFile should not be used");
    })
  };
}

async function createTempSessionManager(): Promise<{
  readonly manager: FileSystemSessionManager;
  readonly sessionFile: string;
  readonly tempDir: string;
}> {
  const createdTempDir = await mkdtemp(path.join(os.tmpdir(), "fledgling-prompt-test-"));
  tempDir = createdTempDir;
  process.env.FLEDGLING_CONFIG = path.join(createdTempDir, "missing-config.json");
  const sessionFile = path.join(createdTempDir, "session.jsonl");
  process.env.FLEDGLING_SESSION_FILE = sessionFile;
  return {
    manager: new FileSystemSessionManager(createdTempDir, sessionFile),
    sessionFile,
    tempDir: createdTempDir
  };
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
