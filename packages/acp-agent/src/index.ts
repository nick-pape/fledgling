import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import "dotenv/config";
import * as acp from "@agentclientprotocol/sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type CoreMessage } from "ai";

type SessionState = {
  readonly id: string;
  readonly cwd: string | undefined;
  readonly history: CoreMessage[];
};

const DEFAULT_SYSTEM_PROMPT =
  "You are Fledgling, a small ACP-native assistant. Answer directly and do not claim access to tools or files unless the client provides them.";

class FledglingAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions = new Map<string, SessionState>();

  public constructor(connection: acp.AgentSideConnection) {
    this.#connection = connection;
  }

  public async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {}
    };
  }

  public async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const session: SessionState = {
      id: randomUUID(),
      cwd: params.cwd,
      history: []
    };

    this.#sessions.set(session.id, session);

    return {
      sessionId: session.id
    };
  }

  public async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  public async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${params.sessionId}`);
    }

    const userText = extractPromptText(params);
    session.history.push({ role: "user", content: userText });

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    });

    const modelName = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
    const result = streamText({
      model: openai(modelName),
      system: process.env.FLEDGLING_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
      messages: session.history
    });

    let assistantText = "";

    for await (const delta of result.textStream) {
      assistantText += delta;
      await this.#connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: delta
          }
        }
      });
    }

    session.history.push({ role: "assistant", content: assistantText });

    return {
      stopReason: "end_turn"
    };
  }

  public async cancel(_params: acp.CancelNotification): Promise<void> {
    // The v0 loop does not keep cancellable model handles yet.
  }
}

function extractPromptText(params: acp.PromptRequest): string {
  const prompt = params.prompt;

  if (typeof prompt === "string") {
    return prompt;
  }

  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return JSON.stringify(part);
      })
      .join("\n");
  }

  return JSON.stringify(prompt);
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);

new acp.AgentSideConnection((connection) => new FledglingAgent(connection), stream);
