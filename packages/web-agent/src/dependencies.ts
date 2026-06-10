import type * as acp from "@agentclientprotocol/sdk";
import {
  type FledglingAgentDependencies,
  type IModelTurnRunner,
  FledglingAgent
} from "@fledgling/agent-core";
import {
  createWebWorkspaceSidecar,
  type IWorkspaceRuntime
} from "@fledgling/mcp-workspace-browser";
import { LocalStorageSessionManager } from "@fledgling/session-local-storage";

import { WebMcpToolProvider } from "./tool-provider.js";

/**
 * Options used to compose a browser-hosted Fledgling agent.
 *
 * @public
 */
export interface WebAgentOptions {
  /**
   * Browser workspace runtime that backs the agent's MCP workspace tools.
   */
  readonly workspaceRuntime: IWorkspaceRuntime;

  /**
   * Model turn runner used to generate agent responses.
   */
  readonly modelTurnRunner: IModelTurnRunner;

  /**
   * Web Storage implementation used to persist session events.
   *
   * Defaults to `globalThis.localStorage`.
   */
  readonly storage?: Storage;
}

/**
 * Creates the default browser dependencies for a Fledgling agent.
 *
 * @param options - Browser runtime, model, and optional storage configuration.
 * @returns Dependencies wired for local storage sessions and browser MCP tools.
 *
 * @public
 */
export function createWebAgentDependencies(options: WebAgentOptions): FledglingAgentDependencies {
  return {
    sessionManager: new LocalStorageSessionManager({ storage: options.storage }),
    toolProvider: new WebMcpToolProvider({
      createSidecar: () => createWebWorkspaceSidecar(options.workspaceRuntime)
    }),
    modelTurnRunner: options.modelTurnRunner,
    logger: console
  };
}

/**
 * Creates a Fledgling agent with browser-oriented default dependencies.
 *
 * @param connection - ACP connection used by the agent.
 * @param options - Browser runtime, model, and optional storage configuration.
 * @returns A Fledgling agent ready to run against the supplied connection.
 *
 * @public
 */
export function createWebAgent(connection: acp.AgentSideConnection, options: WebAgentOptions): FledglingAgent {
  return new FledglingAgent(connection, createWebAgentDependencies(options));
}
