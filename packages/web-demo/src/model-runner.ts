import type { CoreMessage, ToolSet } from "ai";
import type { IModelTurnRunner, ModelStreamPart, ModelTurnRequest } from "@fledgling/web-agent";

const DEFAULT_SYSTEM_PROMPT =
  "You are Fledgling, a small ACP-native assistant running directly in a browser. Answer directly. Use workspace tools when the user asks you to inspect, create, modify, search, or execute something in the workspace.";

export type DemoModelProvider = "openai" | "webllm-qwen";

export interface ModelLoadStatus {
  readonly provider: DemoModelProvider;
  readonly ready: boolean;
  readonly progress?: number;
  readonly text?: string;
  readonly error?: string;
  readonly device?: string;
}

export interface BrowserModelTurnRunner extends IModelTurnRunner {
  readonly provider: DemoModelProvider;
  readonly model: string;
  readonly endpoint: string;
  readonly ready: boolean;
  readonly status: ModelLoadStatus;
  warmup?(): Promise<void>;
  dispose?(): Promise<void>;
}

export function createModelTurnRunner(options: {
  readonly provider: DemoModelProvider;
  readonly envSource: ImportMetaEnv;
  readonly onStatusChange: (status: ModelLoadStatus) => void;
}): BrowserModelTurnRunner {
  if (options.provider === "webllm-qwen") {
    return new BrowserWebLlmModelTurnRunner({
      model: env(options.envSource, "VITE_WEBLLM_MODEL", "Qwen3.5-0.8B-q4f16_1-MLC"),
      onStatusChange: options.onStatusChange
    });
  }

  return new BrowserOpenAiModelTurnRunner(options.envSource);
}

export class BrowserOpenAiModelTurnRunner implements BrowserModelTurnRunner {
  readonly provider = "openai";
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

  public get ready(): boolean {
    return true;
  }

  public get status(): ModelLoadStatus {
    return {
      provider: this.provider,
      ready: true,
      text: "Remote endpoint",
      device: "CPU"
    };
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

export class BrowserWebLlmModelTurnRunner implements BrowserModelTurnRunner {
  readonly provider = "webllm-qwen";
  readonly #model: string;
  readonly #onStatusChange: (status: ModelLoadStatus) => void;
  #enginePromise: Promise<WebLlmEngine> | undefined;
  #engine: WebLlmEngine | undefined;
  #status: ModelLoadStatus;
  #supportsToolCalls = false;

  public constructor(options: { readonly model: string; readonly onStatusChange: (status: ModelLoadStatus) => void }) {
    this.#model = options.model;
    this.#onStatusChange = options.onStatusChange;
    this.#status = {
      provider: this.provider,
      ready: false,
      progress: 0,
      text: "Not loaded",
      device: "GPU loading"
    };
  }

  public get model(): string {
    return this.#model;
  }

  public get endpoint(): string {
    return "WebLLM";
  }

  public get ready(): boolean {
    return this.#status.ready;
  }

  public get status(): ModelLoadStatus {
    return this.#status;
  }

  public async warmup(): Promise<void> {
    await this.#resolveEngine();
  }

  public async dispose(): Promise<void> {
    this.#engine?.interruptGenerate();
    await this.#engine?.unload();
    this.#engine = undefined;
    this.#enginePromise = undefined;
  }

  public runModelTurn(request: ModelTurnRequest): { readonly fullStream: AsyncIterable<ModelStreamPart> } {
    return {
      fullStream: this.#runTurn(request)
    };
  }

  async *#runTurn(request: ModelTurnRequest): AsyncIterable<ModelStreamPart> {
    const engine = await this.#resolveEngine();
    let messages = toWebLlmMessages(request.messages);
    const tools = toWebLlmTools(request.tools);

    if (!this.#supportsToolCalls && tools.length > 0) {
      yield* this.#runManualToolTurn(engine, request, messages, tools);
      return;
    }

    for (let step = 0; step < 5; step++) {
      if (request.abortSignal.aborted) {
        engine.interruptGenerate();
        return;
      }

      const stream = await engine.chat.completions.create({
        model: this.#model,
        messages,
        stream: true,
        max_tokens: 1024,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : "none",
        extra_body: {
          enable_thinking: false
        }
      });

      let toolCalls: WebLlmToolCall[] = [];
      for await (const chunk of stream) {
        if (request.abortSignal.aborted) {
          engine.interruptGenerate();
          return;
        }

        const choice = chunk.choices[0];
        const content = choice?.delta.content;
        if (content) {
          yield { type: "text-delta", text: content };
        }

        const deltaToolCalls = choice?.delta.tool_calls;
        if (deltaToolCalls && deltaToolCalls.length > 0) {
          toolCalls = normalizeToolCalls(deltaToolCalls);
        }
      }

      if (toolCalls.length === 0) {
        return;
      }

      messages = [
        ...messages,
        {
          role: "assistant",
          content: null,
          tool_calls: toolCalls
        }
      ];

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const input = parseToolArguments(toolCall.function.arguments);
        yield {
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName,
          input
        };

        try {
          const output = await executeTool(request.tools, toolName, input);
          yield {
            type: "tool-result",
            toolCallId: toolCall.id,
            output
          };
          messages = [
            ...messages,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: stringifyToolMessage(output)
            }
          ];
        } catch (error) {
          yield {
            type: "tool-error",
            toolCallId: toolCall.id,
            error
          };
          messages = [
            ...messages,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: stringifyToolMessage(error)
            }
          ];
        }
      }
    }
  }

  async #resolveEngine(): Promise<WebLlmEngine> {
    if (this.#engine) {
      return this.#engine;
    }

    if (!this.#enginePromise) {
      this.#enginePromise = this.#createEngine();
    }

    this.#engine = await this.#enginePromise;
    return this.#engine;
  }

  async #createEngine(): Promise<WebLlmEngine> {
    if (!("gpu" in navigator)) {
      const status: ModelLoadStatus = {
        provider: this.provider,
        ready: false,
        error: "WebGPU is not available in this browser.",
        text: "WebGPU unavailable",
        device: "GPU unavailable"
      };
      this.#setStatus(status);
      throw new Error(status.error);
    }

    this.#setStatus({
      provider: this.provider,
      ready: false,
      progress: 0,
      text: "Loading WebLLM",
      device: "GPU loading"
    });

    const webllm = await import("@mlc-ai/web-llm");
    this.#supportsToolCalls = webllm.functionCallingModelIds.includes(this.#model);
    const worker = new Worker(new URL("./webllm-worker.ts", import.meta.url), { type: "module" });
    const engine = await webllm.CreateWebWorkerMLCEngine(
      worker,
      this.#model,
      {
        initProgressCallback: (report) => {
          this.#setStatus({
            provider: this.provider,
            ready: false,
            progress: report.progress,
            text: report.text,
            device: "GPU loading"
          });
        }
      },
      {
        temperature: 0.2
      }
    );
    const gpuVendor = await engine.getGPUVendor().catch(() => undefined);
    this.#setStatus({
      provider: this.provider,
      ready: true,
      progress: 1,
      text: this.#supportsToolCalls ? "Local model ready" : "Local model ready; manual tools",
      device: gpuVendor ? `GPU: ${gpuVendor}` : "GPU"
    });
    return engine as WebLlmEngine;
  }

  #setStatus(status: ModelLoadStatus): void {
    this.#status = status;
    this.#onStatusChange(status);
  }

  async *#runManualToolTurn(
    engine: WebLlmEngine,
    request: ModelTurnRequest,
    messages: WebLlmMessage[],
    tools: readonly WebLlmTool[]
  ): AsyncIterable<ModelStreamPart> {
    let conversation: WebLlmMessage[] = [
      {
        role: "system",
        content: manualToolSystemPrompt(tools)
      },
      ...messages.filter((message) => message.role !== "system")
    ];

    for (let step = 0; step < 5; step++) {
      if (request.abortSignal.aborted) {
        engine.interruptGenerate();
        return;
      }

      const stream = await engine.chat.completions.create({
        model: this.#model,
        messages: conversation,
        stream: true,
        max_tokens: 1024,
        extra_body: {
          enable_thinking: false
        }
      });

      let response: ManualToolResponse | undefined;
      for await (const part of readManualToolResponse(stream, request.abortSignal, engine)) {
        if (part.type === "manual-response") {
          response = part;
        } else {
          yield part;
        }
      }
      if (!response) {
        return;
      }

      const toolCalls = parseQwenToolCalls(response.raw);
      if (toolCalls.length === 0) {
        const text = response.streamedText ? "" : stripThinking(response.raw).trim();
        if (text) {
          yield { type: "text-delta", text };
        }

        return;
      }

      conversation = [
        ...conversation,
        {
          role: "assistant",
          content: response.raw
        }
      ];

      const toolResponses: string[] = [];
      for (const [index, toolCall] of toolCalls.entries()) {
        const toolCallId = `webllm-${Date.now()}-${step}-${index}`;
        yield {
          type: "tool-call",
          toolCallId,
          toolName: toolCall.name,
          input: toolCall.arguments
        };

        try {
          const output = await executeTool(request.tools, toolCall.name, toolCall.arguments);
          yield {
            type: "tool-result",
            toolCallId,
            output
          };
          toolResponses.push(`<tool_response>\n${stringifyToolMessage(output)}\n</tool_response>`);
        } catch (error) {
          yield {
            type: "tool-error",
            toolCallId,
            error
          };
          toolResponses.push(`<tool_response>\n${stringifyToolMessage(error)}\n</tool_response>`);
        }
      }

      conversation = [
        ...conversation,
        {
          role: "user",
          content: `${toolResponses.join("\n")}\n\nUse the tool response above to answer the user's original request in natural language. Do not call another tool unless the tool response is insufficient.`
        }
      ];
    }
  }
}

function toWebLlmMessages(messages: readonly CoreMessage[]): WebLlmMessage[] {
  return [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...messages.map(toWebLlmMessage)];
}

function toWebLlmMessage(message: CoreMessage): WebLlmMessage {
  if (message.role === "system" || message.role === "user" || message.role === "assistant") {
    return {
      role: message.role,
      content: contentToText(message.content)
    };
  }

  return {
    role: "tool",
    content: contentToText(message.content),
    tool_call_id: "tool"
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

function toWebLlmTools(tools: ToolSet): WebLlmTool[] {
  return Object.entries(tools).map(([name, tool]) => {
    const record = tool as Record<string, unknown>;
    return {
      type: "function",
      function: {
        name,
        description: typeof record.description === "string" ? record.description : `Call ${name}.`,
        parameters: toJsonSchema(record.inputSchema ?? record.parameters)
      }
    };
  });
}

async function* readManualToolResponse(
  stream: AsyncIterable<WebLlmChatChunk>,
  abortSignal: AbortSignal,
  engine: WebLlmEngine
): AsyncIterable<ModelStreamPart | ManualToolResponse> {
  let raw = "";
  let streamedLength = 0;
  let mode: "undecided" | "final" | "tool" = "undecided";
  let streamedText = false;

  for await (const chunk of stream) {
    if (abortSignal.aborted) {
      engine.interruptGenerate();
      yield { type: "manual-response", raw, streamedText };
      return;
    }

    raw += chunk.choices[0]?.delta.content ?? "";
    if (mode === "tool") {
      continue;
    }

    const visible = visibleManualText(raw);
    if (mode === "undecided") {
      const trimmed = visible.trimStart();
      if (trimmed.length === 0) {
        continue;
      }

      const protocolPrefix = stripLeadingCodeFencePrefix(trimmed);
      if (protocolPrefix === undefined) {
        continue;
      }

      if (protocolPrefix.startsWith("<tool_call")) {
        mode = "tool";
        continue;
      }

      if (isPossibleToolCallPrefix(protocolPrefix)) {
        continue;
      }

      mode = "final";
    }

    if (mode === "final" && visible.length > streamedLength) {
      const text = visible.slice(streamedLength);
      streamedLength = visible.length;
      if (text) {
        streamedText = true;
        yield { type: "text-delta", text };
      }
    }
  }

  yield { type: "manual-response", raw, streamedText };
}

function manualToolSystemPrompt(tools: readonly WebLlmTool[]): string {
  return `${DEFAULT_SYSTEM_PROMPT}

You are provided with function signatures inside <tools></tools> XML tags.
<tools>
${JSON.stringify(tools, undefined, 2)}
</tools>

Use tools only when the user asks you to inspect, modify, search, list, or run something in the workspace. Do not use workspace.write_file for ordinary writing or composition requests unless the user explicitly asks you to save content to a file.

When a tool is needed, return a JSON object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

The arguments field must be an object. You may call multiple tools by returning multiple <tool_call> blocks. If no tool is needed, answer normally.`;
}

function isPossibleToolCallPrefix(trimmed: string): boolean {
  const target = "<tool_call";
  return target.startsWith(trimmed.toLowerCase());
}

function stripLeadingCodeFencePrefix(trimmed: string): string | undefined {
  if (!"`".repeat(3).startsWith(trimmed) && !trimmed.startsWith("```")) {
    return trimmed.toLowerCase();
  }

  if (!trimmed.startsWith("```")) {
    return undefined;
  }

  const newlineIndex = trimmed.indexOf("\n");
  if (newlineIndex === -1) {
    return undefined;
  }

  return trimmed.slice(newlineIndex + 1).trimStart().toLowerCase();
}

function parseQwenToolCalls(raw: string): QwenToolCall[] {
  const text = stripThinking(raw);
  const calls: QwenToolCall[] = [];
  for (const block of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    const body = block[1]?.trim() ?? "";
    const jsonCall = parseQwenJsonToolCall(body);
    if (jsonCall) {
      calls.push(jsonCall);
      continue;
    }

    const xmlCall = parseQwenXmlToolCall(body);
    if (xmlCall) {
      calls.push(xmlCall);
    }
  }

  return calls;
}

function parseQwenJsonToolCall(body: string): QwenToolCall | undefined {
  const json = extractFirstJsonObject(body);
  if (!json) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(json) as { readonly name?: unknown; readonly arguments?: unknown };
    if (typeof parsed.name !== "string") {
      return undefined;
    }

    return {
      name: parsed.name,
      arguments: parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {}
    };
  } catch {
    return undefined;
  }
}

function parseQwenXmlToolCall(body: string): QwenToolCall | undefined {
  const functionMatch = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/i.exec(body);
  if (!functionMatch) {
    return undefined;
  }

  const args: Record<string, string> = {};
  for (const parameter of functionMatch[2].matchAll(/<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
    args[parameter[1]] = parameter[2].trim();
  }

  return {
    name: functionMatch[1],
    arguments: args
  };
}

function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object") {
    return schema as Record<string, unknown>;
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
}

function normalizeToolCalls(toolCalls: readonly WebLlmDeltaToolCall[]): WebLlmToolCall[] {
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id ?? String(toolCall.index ?? index),
    type: "function",
    function: {
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "{}"
    }
  }));
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function extractFirstJsonObject(raw: string): string | undefined {
  const text = stripThinking(raw);
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function stripThinking(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*<think>[\s\S]*/i, "")
    .trim();
}

function visibleManualText(raw: string): string {
  const withoutClosedThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  return withoutClosedThinking.replace(/<think>[\s\S]*$/i, "");
}

async function executeTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name] as { execute?: (input: unknown, options?: unknown) => Promise<unknown> | unknown } | undefined;
  if (!tool?.execute) {
    throw new Error(`Tool is not executable: ${name}`);
  }

  return tool.execute(input);
}

function stringifyToolMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  return JSON.stringify(value);
}

function env(envSource: ImportMetaEnv, name: string, fallback: string): string {
  const value = envSource[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

interface WebLlmEngine {
  readonly chat: {
    readonly completions: {
      create(request: WebLlmChatRequest): Promise<AsyncIterable<WebLlmChatChunk>>;
    };
  };
  interruptGenerate(): void;
  unload(): Promise<void>;
  getGPUVendor(): Promise<string>;
}

interface WebLlmChatRequest {
  readonly model: string;
  readonly messages: readonly WebLlmMessage[];
  readonly stream: true;
  readonly max_tokens?: number;
  readonly tools?: readonly WebLlmTool[];
  readonly tool_choice?: "auto" | "none";
  readonly response_format?: {
    readonly type: "json_object";
    readonly schema?: string;
  };
  readonly extra_body?: {
    readonly enable_thinking?: boolean;
  };
}

interface QwenToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

interface ManualToolResponse {
  readonly type: "manual-response";
  readonly raw: string;
  readonly streamedText: boolean;
}

type WebLlmMessage =
  | {
      readonly role: "system" | "user" | "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly WebLlmToolCall[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_call_id: string;
    };

interface WebLlmTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

interface WebLlmChatChunk {
  readonly choices: readonly {
    readonly delta: {
      readonly content?: string | null;
      readonly tool_calls?: readonly WebLlmDeltaToolCall[];
    };
  }[];
}

interface WebLlmDeltaToolCall {
  readonly index?: number;
  readonly id?: string;
  readonly type?: "function";
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

interface WebLlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}
