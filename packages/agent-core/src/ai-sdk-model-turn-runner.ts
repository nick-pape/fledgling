import { stepCountIs, streamText, type LanguageModel, type ToolSet } from "ai";

import type { IModelTurnRunner, ModelStreamPart, ModelTurnRequest, ModelTurnResult } from "./interfaces.js";

/** Tool choice setting accepted by the AI SDK model turn runner. */
export type AiSdkToolChoice = "auto" | { readonly type: "tool"; readonly toolName: string };

/** Options for creating an AI SDK backed model turn runner. */
export interface AiSdkModelTurnRunnerOptions {
  /** Resolves the language model used for each turn. */
  readonly resolveModel: () => LanguageModel;

  /** Resolves an optional system prompt for each turn. */
  readonly resolveSystemPrompt?: () => string | undefined;

  /** Resolves the AI SDK tool choice for the current tool set. */
  readonly resolveToolChoice?: (tools: ToolSet) => AiSdkToolChoice | undefined;

  /** Maximum number of model steps allowed in one turn. */
  readonly maxSteps?: number;
}

/** Runs prompt turns through the Vercel AI SDK streaming API. */
export class AiSdkModelTurnRunner implements IModelTurnRunner {
  readonly #options: AiSdkModelTurnRunnerOptions;

  /** Creates a model turn runner with lazily resolved AI SDK options. */
  public constructor(options: AiSdkModelTurnRunnerOptions) {
    this.#options = options;
  }

  /** Starts a model turn and returns the normalized full stream. */
  public runModelTurn(request: ModelTurnRequest): ModelTurnResult {
    const result = streamText({
      model: this.#options.resolveModel(),
      system: this.#options.resolveSystemPrompt?.(),
      messages: request.messages,
      tools: request.tools,
      toolChoice: this.#options.resolveToolChoice?.(request.tools) ?? "auto",
      stopWhen: stepCountIs(this.#options.maxSteps ?? 5),
      abortSignal: request.abortSignal
    });

    return {
      fullStream: result.fullStream as AsyncIterable<ModelStreamPart>
    };
  }
}
