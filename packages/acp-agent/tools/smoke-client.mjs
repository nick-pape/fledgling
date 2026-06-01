import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const prompt =
  process.argv.slice(2).join(" ") ||
  "Dry run: reply with exactly: fledgling dry run ok";
const sessionCwd = resolve(process.env.FLEDGLING_SMOKE_CWD || process.cwd());
const childEnv = { ...process.env };

if (!childEnv.FLEDGLING_CONFIG && existsSync("fledgling.config.example.json")) {
  childEnv.FLEDGLING_CONFIG = "fledgling.config.example.json";
}

class SmokeClient {
  text = "";

  async sessionUpdate(params) {
    const { update } = params;

    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.text += update.content.text;
      process.stdout.write(update.content.text);
    } else if (update.sessionUpdate === "tool_call") {
      console.error(
        JSON.stringify({
          toolCall: update.title,
          status: update.status,
          input: update.rawInput
        })
      );
    } else if (update.sessionUpdate === "tool_call_update") {
      console.error(
        JSON.stringify({
          toolCallId: update.toolCallId,
          status: update.status,
          output: update.rawOutput
        })
      );
    }
  }

  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  }

  async writeTextFile() {
    return {};
  }

  async readTextFile() {
    return { content: "" };
  }
}

const child = spawn(process.execPath, ["lib/index.js"], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ["pipe", "pipe", "inherit"]
});

const client = new SmokeClient();
const connection = new acp.ClientSideConnection(
  () => client,
  acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
);

try {
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  });

  const session = await connection.newSession({
    cwd: sessionCwd,
    mcpServers: []
  });

  console.error(
    JSON.stringify({
      initialized: true,
      protocolVersion: init.protocolVersion,
      agentCapabilities: init.agentCapabilities,
      cwd: sessionCwd,
      sessionId: session.sessionId
    })
  );

  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: prompt }]
  });

  console.error(
    "\n" +
      JSON.stringify({
        stopReason: result.stopReason,
        responseLength: client.text.length
      })
  );
} finally {
  child.kill();
}
