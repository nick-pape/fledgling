#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import { config as loadDotenv } from "dotenv";
import pino from "pino";
import pretty from "pino-pretty";

loadHostEnv();

const deterministic = hasFlag("--deterministic") || process.env.FLEDGLING_HOST_DETERMINISTIC === "1";
const jsonOutput = deterministic || hasFlag("--json") || process.env.FLEDGLING_HOST_JSON === "1";
const includeWorkspaceMcp = hasFlag("--workspace-mcp") || process.env.FLEDGLING_HOST_WORKSPACE_MCP === "1";
const promptArgs = process.argv
  .slice(2)
  .filter((arg) => arg !== "--deterministic" && arg !== "--json" && arg !== "--workspace-mcp");
const prompt = promptArgs.join(" ") || "Reply with exactly: fledgling host log ok";
const sessionCwd = path.resolve(process.env.FLEDGLING_HOST_CWD ?? process.cwd());
const mcpServers = await readMcpServers();
const logger = createLogger();
let pendingText:
  | {
      sessionId: string;
      text: string;
    }
  | undefined;

class LoggingHost implements acp.Client {
  public text = "";

  public async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const { update } = params;

    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.text += update.content.text;
    }

    emitTranscript("session/update", params);
  }

  public async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    emitTranscript("session/request_permission", { params });
    return { outcome: { outcome: "cancelled" } };
  }

  public async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    emitTranscript("fs/write_text_file", { params });
    return {};
  }

  public async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    emitTranscript("fs/read_text_file", { params });
    return { content: "" };
  }
}

const childEnv = { ...process.env };

if (!childEnv.FLEDGLING_CONFIG && existsSync("fledgling.config.example.json")) {
  childEnv.FLEDGLING_CONFIG = "fledgling.config.example.json";
}

const child = spawn(process.env.FLEDGLING_AGENT_COMMAND ?? process.execPath, getAgentArgs(), {
  cwd: process.env.FLEDGLING_AGENT_CWD ?? process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "inherit"]
});

const host = new LoggingHost();
const connection = new acp.ClientSideConnection(
  () => host,
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
);

try {
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  });

  const session = await connection.newSession({
    cwd: sessionCwd,
    mcpServers
  });

  emitTranscript("session/ready", {
    protocolVersion: init.protocolVersion,
    agentCapabilities: init.agentCapabilities,
    cwd: sessionCwd,
    mcpServers: mcpServers.map((server) => server.name),
    sessionId: session.sessionId
  });

  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: prompt }]
  });

  emitTranscript("session/done", {
    stopReason: result.stopReason,
    responseLength: host.text.length
  });
} finally {
  flushTranscript();
  logger.flush();
  child.kill();
}

type TranscriptEventName =
  | "session/ready"
  | "session/update"
  | "session/request_permission"
  | "fs/write_text_file"
  | "fs/read_text_file"
  | "session/done";

function createLogger(): pino.Logger {
  const options: pino.LoggerOptions = {
    base: undefined,
    timestamp: false,
    formatters: {
      level: (label) => ({ level: label })
    }
  };

  if (jsonOutput) {
    return pino(options);
  }

  return pino(
    options,
    pretty({
      colorize: false,
      hideObject: true,
      ignore: "pid,hostname,time,level",
      messageFormat: "{msg}",
      sync: true
    })
  );
}

function emitTranscript(event: TranscriptEventName, payload: unknown): void {
  const textChunk = event === "session/update" ? getTextChunk(payload as acp.SessionNotification) : undefined;
  if ((deterministic || !jsonOutput) && textChunk) {
    pendingText =
      pendingText && pendingText.sessionId === textChunk.sessionId
        ? { sessionId: pendingText.sessionId, text: pendingText.text + textChunk.text }
        : textChunk;
    return;
  }

  flushTranscript();
  writeTranscript(event, payload);
}

function flushTranscript(): void {
  if (!pendingText) {
    return;
  }

  writeTranscript("session/update", {
    sessionId: pendingText.sessionId,
    update: {
      sessionUpdate: "agent_message",
      content: {
        type: "text",
        text: pendingText.text
      }
    }
  });
  pendingText = undefined;
}

function writeTranscript(event: TranscriptEventName, payload: unknown): void {
  const payloadForOutput = deterministic ? normalizeForSnapshot(payload) : payload;
  const record = { event, ...toEventPayload(payloadForOutput) };

  if (jsonOutput) {
    logger.info(record);
    return;
  }

  logger.info(record, formatHumanMessage(event, payload));
}

function formatHumanMessage(event: TranscriptEventName, payload: unknown): string {
  switch (event) {
    case "session/ready": {
      const ready = payload as {
        protocolVersion?: number;
        mcpServers?: string[];
        sessionId?: string;
      };
      return [
        `session ready ${ready.sessionId ?? "<unknown>"}`,
        `protocol ${ready.protocolVersion ?? "<unknown>"}`,
        `mcp servers ${ready.mcpServers?.length ? ready.mcpServers.join(", ") : "(none)"}`
      ].join("\n");
    }

    case "session/update":
      return formatHumanSessionUpdate(payload as acp.SessionNotification);

    case "session/request_permission":
    case "fs/write_text_file":
    case "fs/read_text_file":
      return `${event} ${JSON.stringify(payload)}`;

    case "session/done": {
      const done = payload as { stopReason?: string; responseLength?: number };
      return `session done ${done.stopReason ?? "<unknown>"} (${done.responseLength ?? 0} chars)`;
    }
  }
}

function formatHumanSessionUpdate(params: acp.SessionNotification): string {
  const { update } = params;
  const coalescedUpdate = update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
  if (coalescedUpdate.sessionUpdate === "agent_message") {
    return coalescedUpdate.content?.type === "text" ? (coalescedUpdate.content.text ?? "") : JSON.stringify(update);
  }

  switch (update.sessionUpdate) {
    case "tool_call":
      return update.rawInput === undefined
        ? `tool ${update.title} pending`
        : `tool ${update.title} pending\ninput ${JSON.stringify(update.rawInput)}`;

    case "tool_call_update":
      return update.rawOutput === undefined
        ? `tool ${update.toolCallId} ${update.status}`
        : `tool ${update.toolCallId} ${update.status}\noutput ${JSON.stringify(update.rawOutput)}`;

    case "agent_message_chunk":
      return update.content.type === "text"
        ? update.content.text
        : `agent content ${JSON.stringify(update.content)}`;

    default:
      return JSON.stringify(update);
  }
}

function getTextChunk(params: acp.SessionNotification): { sessionId: string; text: string } | undefined {
  const { update } = params;
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
    return undefined;
  }

  return {
    sessionId: params.sessionId,
    text: update.content.text
  };
}

function toEventPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return { payload };
}

function normalizeForSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForSnapshot(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "sessionId") {
          return [key, "<session>"];
        }

        if (key === "toolCallId") {
          return [key, "<tool-call>"];
        }

        if (key === "cwd") {
          return [key, "<cwd>"];
        }

        if (key === "mtimeMs") {
          return [key, 0];
        }

        return [key, normalizeForSnapshot(child)];
      })
    );
  }

  if (typeof value === "string") {
    return normalizeString(value);
  }

  return value;
}

function normalizeString(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(normalizeForSnapshot(JSON.parse(value)));
    } catch {
      // Fall back to path normalization for ordinary text that only looks like JSON.
    }
  }

  return value.replaceAll(sessionCwd, "<cwd>").replaceAll(sessionCwd.replaceAll("\\", "/"), "<cwd>");
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getAgentArgs(): string[] {
  if (process.env.FLEDGLING_AGENT_ARGS_JSON) {
    return JSON.parse(process.env.FLEDGLING_AGENT_ARGS_JSON) as string[];
  }

  return [fileURLToPath(import.meta.resolve("@fledgling/acp-agent"))];
}

function loadHostEnv(): void {
  const envPath = findEnvPath();
  if (envPath) {
    loadDotenv({ path: envPath, quiet: true });
  }
}

function findEnvPath(): string | undefined {
  if (process.env.FLEDGLING_ENV_FILE) {
    return path.resolve(process.env.FLEDGLING_ENV_FILE);
  }

  const defaultAgentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@fledgling/acp-agent"))), "..");
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    process.env.FLEDGLING_AGENT_CWD ? path.resolve(process.env.FLEDGLING_AGENT_CWD, ".env") : undefined,
    path.resolve(defaultAgentRoot, ".env")
  ];

  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}

async function readMcpServers(): Promise<acp.McpServer[]> {
  const servers: acp.McpServer[] = [];

  if (includeWorkspaceMcp) {
    servers.push({
      name: "workspace",
      command: process.execPath,
      args: [fileURLToPath(import.meta.resolve("@fledgling/mcp-workspace"))],
      env: []
    });
  }

  const mcpServersJson = process.env.FLEDGLING_HOST_MCP_SERVERS;
  if (mcpServersJson) {
    servers.push(...(JSON.parse(mcpServersJson) as acp.McpServer[]));
  }

  const mcpServersFile = process.env.FLEDGLING_HOST_MCP_SERVERS_FILE;
  if (mcpServersFile) {
    servers.push(...(JSON.parse(await readFile(path.resolve(mcpServersFile), "utf8")) as acp.McpServer[]));
  }

  return servers;
}
