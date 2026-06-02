import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { FledglingAgent } from "./agent.js";
import { registerProcessLifecycle } from "./process-lifecycle.js";

const input: WritableStream<Uint8Array> = Writable.toWeb(process.stdout);
const output: ReadableStream<Uint8Array> = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream: ReturnType<typeof acp.ndJsonStream> = acp.ndJsonStream(input, output);

let activeAgent: FledglingAgent | undefined;

registerProcessLifecycle(() => activeAgent);

// eslint-disable-next-line no-new -- AgentSideConnection owns the stdio lifecycle.
new acp.AgentSideConnection((connection) => {
  activeAgent = new FledglingAgent(connection);
  return activeAgent;
}, stream);
