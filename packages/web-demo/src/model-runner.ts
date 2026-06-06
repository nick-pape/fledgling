import type { IModelTurnRunner, ModelStreamPart, ModelTurnRequest } from "@fledgling/web-agent";

const DEFAULT_SYSTEM_PROMPT =
  "You are Fledgling, a small ACP-native assistant running directly in a browser. Answer directly. Use workspace tools when the user asks you to inspect, create, modify, search, or execute something in the workspace.";

export class BrowserOpenAiModelTurnRunner implements IModelTurnRunner {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;

  public constructor(envSource: ImportMetaEnv) {
    this.#baseUrl = env(envSource, "VITE_OPENAI_BASE_URL", "https://api.openai.com/v1");
    this.#apiKey = env(envSource, "VITE_OPENAI_API_KEY", "");
    this.#model = env(envSource, "VITE_OPENAI_MODEL", "gpt-4.1-mini");
  }

  public get model(): string {
    return this.#model;
  }

  public get endpoint(): string {
    return this.#baseUrl;
  }

  public runModelTurn(request: ModelTurnRequest): { readonly fullStream: AsyncIterable<ModelStreamPart> } {
    return {
      fullStream: this.#runSharedTurn(request)
    };
  }

  async *#runSharedTurn(request: ModelTurnRequest): AsyncIterable<ModelStreamPart> {
    if (!this.#apiKey) {
      throw new Error("VITE_OPENAI_API_KEY is not set");
    }

    const [{ createOpenAI }, { AiSdkModelTurnRunner }] = await Promise.all([
      import("@ai-sdk/openai"),
      import("@fledgling/web-agent")
    ]);
    const openai = createOpenAI({
      apiKey: this.#apiKey,
      baseURL: this.#baseUrl
    });
    const runner = new AiSdkModelTurnRunner({
      resolveModel: () => openai.chat(this.#model),
      resolveSystemPrompt: () => DEFAULT_SYSTEM_PROMPT
    });

    yield* runner.runModelTurn(request).fullStream;
  }
}

function env(envSource: ImportMetaEnv, name: string, fallback: string): string {
  const value = envSource[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
