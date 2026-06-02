#!/usr/bin/env node
import { spawn, type ChildProcessByStdio } from "node:child_process";
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

const deterministic: boolean = hasFlag("--deterministic") || process.env.FLEDGLING_HOST_DETERMINISTIC === "1";
const jsonOutput: boolean = deterministic || hasFlag("--json") || process.env.FLEDGLING_HOST_JSON === "1";
const includeWorkspaceMcp: boolean =
  hasFlag("--workspace-mcp") || process.env.FLEDGLING_HOST_WORKSPACE_MCP === "1";
const resumeSessionFile: string | undefined = getFlagValue("--session-file") ?? process.env.FLEDGLING_HOST_SESSION_FILE;
const resumeSessionId: string | undefined =
  getFlagValue("--session-id") ?? process.env.FLEDGLING_HOST_SESSION_ID ?? (await readSessionId(resumeSessionFile));
const promptArgs: string[] = stripHostFlags(process.argv.slice(2));
const prompt: string = promptArgs.join(" ") || "Reply with exactly: fledgling host log ok";
const sessionCwd: string = path.resolve(process.env.FLEDGLING_HOST_CWD ?? process.cwd());
const mcpServers: acp.McpServer[] = await readMcpServers();
const logger: pino.Logger = createLogger();

interface PendingText {
  readonly sessionId: string;
  readonly text: string;
}

let pendingText:
  | PendingText
  | undefined;

class LoggingHost implements acp.Client {
  public text: string = "";

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

const childEnv: NodeJS.ProcessEnv = { ...process.env };

if (!childEnv.FLEDGLING_CONFIG && existsSync("fledgling.config.example.json")) {
  childEnv.FLEDGLING_CONFIG = "fledgling.config.example.json";
}

if (resumeSessionFile) {
  childEnv.FLEDGLING_SESSION_FILE = path.resolve(resumeSessionFile);
}

// eslint-disable-next-line @rushstack/no-new-null -- Node's inherited stderr overload is represented as null.
const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
  process.env.FLEDGLING_AGENT_COMMAND ?? process.execPath,
  getAgentArgs(),
  {
  cwd: process.env.FLEDGLING_AGENT_CWD ?? process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "inherit"]
  }
);

const host: LoggingHost = new LoggingHost();
const connection: acp.ClientSideConnection = new acp.ClientSideConnection(
  () => host,
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
);

try {
  const init: acp.InitializeResponse = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  });

  const session: acp.NewSessionResponse = resumeSessionId
    ? {
        sessionId: resumeSessionId,
        ...(await connection.loadSession({
          sessionId: resumeSessionId,
          cwd: sessionCwd,
          mcpServers
        }))
      }
    : await connection.newSession({
        cwd: sessionCwd,
        mcpServers
      });

  emitTranscript("session/ready", {
    protocolVersion: init.protocolVersion,
    agentCapabilities: init.agentCapabilities,
    cwd: sessionCwd,
    mcpServers: mcpServers.map((server) => server.name),
    loaded: resumeSessionId !== undefined,
    sessionId: session.sessionId
  });

  const result: acp.PromptResponse = await connection.prompt({
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
  await waitForChildExit();
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
      level: (label: string) => ({ level: label })
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
      pendingText?.sessionId === textChunk.sessionId
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
  const payloadForOutput: unknown = deterministic ? normalizeForSnapshot(payload) : payload;
  const record: Record<string, unknown> = { event, ...toEventPayload(payloadForOutput) };

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

function getFlagValue(flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  const equalsArg = process.argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsArg) {
    return equalsArg.slice(equalsPrefix.length);
  }

  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function stripHostFlags(args: string[]): string[] {
  const stripped: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--deterministic" || arg === "--json" || arg === "--workspace-mcp") {
      continue;
    }

    if (arg === "--session-id") {
      index++;
      continue;
    }

    if (arg.startsWith("--session-id=")) {
      continue;
    }

    if (arg === "--session-file") {
      index++;
      continue;
    }

    if (arg.startsWith("--session-file=")) {
      continue;
    }

    stripped.push(arg);
  }

  return stripped;
}

async function readSessionId(sessionFile: string | undefined): Promise<string | undefined> {
  if (!sessionFile) {
    return undefined;
  }

  const raw = await readFile(path.resolve(sessionFile), "utf8");
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) {
    return undefined;
  }

  const firstEvent = JSON.parse(firstLine) as { readonly sessionId?: unknown };
  return typeof firstEvent.sessionId === "string" ? firstEvent.sessionId : undefined;
}

function getAgentArgs(): string[] {
  if (process.env.FLEDGLING_AGENT_ARGS_JSON) {
    return JSON.parse(process.env.FLEDGLING_AGENT_ARGS_JSON) as string[];
  }

  return [fileURLToPath(import.meta.resolve("@fledgling/acp-agent"))];
}

function waitForChildExit(timeoutMs: number = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled: boolean = false;
    // eslint-disable-next-line prefer-const -- assigned after finish() is declared so the callback can clear it.
    let timeout: NodeJS.Timeout;

    function finish(): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      child.off("exit", finish);
      resolve();
    }

    timeout = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

function loadHostEnv(): void {
  const envPath: string | undefined = findEnvPath();
  if (envPath) {
    loadDotenv({ path: envPath, quiet: true });
  }
}

function findEnvPath(): string | undefined {
  if (process.env.FLEDGLING_ENV_FILE) {
    return path.resolve(process.env.FLEDGLING_ENV_FILE);
  }

  const defaultAgentRoot: string = path.resolve(
    path.dirname(fileURLToPath(import.meta.resolve("@fledgling/acp-agent"))),
    ".."
  );
  const candidates: (string | undefined)[] = [
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

  const mcpServersJson: string | undefined = process.env.FLEDGLING_HOST_MCP_SERVERS;
  if (mcpServersJson) {
    servers.push(...(JSON.parse(mcpServersJson) as acp.McpServer[]));
  }

  const mcpServersFile = process.env.FLEDGLING_HOST_MCP_SERVERS_FILE;
  if (mcpServersFile) {
    servers.push(...(JSON.parse(await readFile(path.resolve(mcpServersFile), "utf8")) as acp.McpServer[]));
  }

  return servers;
}
