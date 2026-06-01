import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const prompt =
  process.argv.slice(2).join(" ") ||
  "Dry run: reply with exactly: fledgling dry run ok";

class SmokeClient {
  text = "";

  async sessionUpdate(params) {
    const { update } = params;

    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      this.text += update.content.text;
      process.stdout.write(update.content.text);
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
    cwd: process.cwd(),
    mcpServers: []
  });

  console.error(
    JSON.stringify({
      initialized: true,
      protocolVersion: init.protocolVersion,
      agentCapabilities: init.agentCapabilities,
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
