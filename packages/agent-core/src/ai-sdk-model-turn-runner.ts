import { stepCountIs, streamText, type LanguageModel, type ToolSet } from "ai";

import type { IModelTurnRunner, ModelStreamPart, ModelTurnRequest, ModelTurnResult } from "./interfaces.js";

export type AiSdkToolChoice = "auto" | { readonly type: "tool"; readonly toolName: string };

export interface AiSdkModelTurnRunnerOptions {
  readonly resolveModel: () => LanguageModel;
  readonly resolveSystemPrompt?: () => string | undefined;
  readonly resolveToolChoice?: (tools: ToolSet) => AiSdkToolChoice | undefined;
  readonly maxSteps?: number;
}

export class AiSdkModelTurnRunner implements IModelTurnRunner {
  readonly #options: AiSdkModelTurnRunnerOptions;

  public constructor(options: AiSdkModelTurnRunnerOptions) {
    this.#options = options;
  }

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
