import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import {
  AiSdkModelTurnRunner,
  type AiSdkToolChoice,
  type FledglingAgentDependencies,
  type IModelTurnRunner,
  type ModelTurnResult
} from "@fledgling/agent-core";
import { FileSystemSessionManager } from "@fledgling/session-file-system";
import { NodeMcpToolProvider } from "@fledgling/tools-mcp-node";
import { type LanguageModel, type ToolSet } from "ai";

export {
  FledglingAgent,
  type FledglingAgentDependencies,
  type IModelTurnRunner,
  type IRuntimeLogger,
  type ISessionManager,
  type IToolProvider,
  type ModelStreamPart,
  type ModelTurnRequest,
  type ModelTurnResult
} from "@fledgling/agent-core";

const DEFAULT_SYSTEM_PROMPT: string =
  "You are Fledgling, a small ACP-native assistant. Answer directly. Use tools when they are available and useful. If the user asks you to inspect, create, modify, delete, search, or execute something in the workspace, use the relevant workspace tool instead of only describing what you would do. If the user asks you to write content to a file, call the file-writing tool. Do not claim you cannot access files when a relevant workspace tool is available. Tool results may include Fledgling context hints that describe identity, retention, and prompt placement for future context assembly.";

export class VercelAiSdkModelTurnRunner implements IModelTurnRunner {
  readonly #runner: AiSdkModelTurnRunner;

  public constructor() {
    this.#runner = new AiSdkModelTurnRunner({
      resolveModel: () => {
        const openai = createOpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL
        });
        const modelName = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
        return selectOpenAiModel(openai, modelName);
      },
      resolveSystemPrompt: () => process.env.FLEDGLING_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
      resolveToolChoice: getToolChoice
    });
  }

  public runModelTurn(...args: Parameters<IModelTurnRunner["runModelTurn"]>): ModelTurnResult {
    return this.#runner.runModelTurn(...args);
  }
}

function getToolChoice(tools: ToolSet): AiSdkToolChoice {
  const toolName = process.env.FLEDGLING_TOOL_CHOICE;
  if (!toolName) {
    return "auto";
  }

  if (!(toolName in tools)) {
    throw new Error(`FLEDGLING_TOOL_CHOICE references unknown tool: ${toolName}`);
  }

  return { type: "tool", toolName };
}

function selectOpenAiModel(openai: OpenAIProvider, modelName: string): LanguageModel {
  return process.env.FLEDGLING_OPENAI_API === "responses" ? openai.responses(modelName) : openai.chat(modelName);
}

export function createDefaultDependencies(): FledglingAgentDependencies {
  return {
    toolProvider: new NodeMcpToolProvider(),
    sessionManager: new FileSystemSessionManager(),
    modelTurnRunner: new VercelAiSdkModelTurnRunner(),
    logger: {
      debug(value: unknown): void {
        console.error(JSON.stringify(value));
      },
      warn(record: unknown): void {
        console.warn(record);
      },
      error(record: unknown): void {
        console.error(record);
      }
    },
    debugStream: process.env.FLEDGLING_DEBUG_STREAM === "1"
  };
}
