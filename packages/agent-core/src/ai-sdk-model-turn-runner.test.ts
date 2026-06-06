import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiSdkModelTurnRunner } from "./ai-sdk-model-turn-runner.js";

const mocks = vi.hoisted(() => {
  const fullStream = (async function* (): AsyncIterable<never> {})();
  const stopWhen = { kind: "stop-when" };
  return {
    fullStream,
    stopWhen,
    streamText: vi.fn(() => ({ fullStream })),
    stepCountIs: vi.fn(() => stopWhen)
  };
});

vi.mock("ai", () => ({
  streamText: mocks.streamText,
  stepCountIs: mocks.stepCountIs
}));

describe("AiSdkModelTurnRunner", () => {
  beforeEach(() => {
    mocks.streamText.mockClear();
    mocks.stepCountIs.mockClear();
  });

  it("passes messages, tools, abort signal, and defaults into streamText", () => {
    const model = { modelId: "test-model" };
    const messages = [{ role: "user" as const, content: "hello" }];
    const tools = {};
    const abortController = new AbortController();
    const runner = new AiSdkModelTurnRunner({
      resolveModel: () => model as never,
      resolveSystemPrompt: () => "system prompt"
    });

    const result = runner.runModelTurn({
      messages,
      tools,
      abortSignal: abortController.signal
    });

    expect(result.fullStream).toBe(mocks.fullStream);
    expect(mocks.stepCountIs).toHaveBeenCalledWith(5);
    expect(mocks.streamText).toHaveBeenCalledWith({
      model,
      system: "system prompt",
      messages,
      tools,
      toolChoice: "auto",
      stopWhen: mocks.stopWhen,
      abortSignal: abortController.signal
    });
  });

  it("honors an injected tool choice resolver", () => {
    const toolChoice = { type: "tool" as const, toolName: "workspace.read_file" };
    const runner = new AiSdkModelTurnRunner({
      resolveModel: () => ({}) as never,
      resolveToolChoice: () => toolChoice
    });

    runner.runModelTurn({
      messages: [],
      tools: {},
      abortSignal: new AbortController().signal
    });

    expect(mocks.streamText).toHaveBeenCalledWith(expect.objectContaining({ toolChoice }));
  });

  it("uses the configured max step count", () => {
    const runner = new AiSdkModelTurnRunner({
      resolveModel: () => ({}) as never,
      maxSteps: 3
    });

    runner.runModelTurn({
      messages: [],
      tools: {},
      abortSignal: new AbortController().signal
    });

    expect(mocks.stepCountIs).toHaveBeenCalledWith(3);
  });
});
