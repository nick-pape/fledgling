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

export interface WebAgentOptions {
  readonly workspaceRuntime: IWorkspaceRuntime;
  readonly modelTurnRunner: IModelTurnRunner;
  readonly storage?: Storage;
}

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

export function createWebAgent(connection: acp.AgentSideConnection, options: WebAgentOptions): FledglingAgent {
  return new FledglingAgent(connection, createWebAgentDependencies(options));
}
