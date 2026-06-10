import * as acp from "@agentclientprotocol/sdk";
import type { IModelTurnRunner, IWorkspaceRuntime } from "@fledgling/web-agent";

export type DemoWorkspaceProvider = "nodepod" | "webcontainer";

export interface DemoSession {
  readonly connection: acp.ClientSideConnection;
  readonly protocolVersion: string;
  readonly sessionId: string;
}

class DemoClient {
  readonly #onUpdate: (params: acp.SessionNotification) => void;

  public constructor(onUpdate: (params: acp.SessionNotification) => void) {
    this.#onUpdate = onUpdate;
  }

  public async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.#onUpdate(params);
  }

  public async requestPermission(): Promise<acp.RequestPermissionResponse> {
    // The demo client implements the ACP client surface, but workspace access in
    // this app is provided by browser MCP workspace tools.
    return { outcome: { outcome: "cancelled" } };
  }

  public async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    // Inert ACP filesystem stub; workspace writes are provided by MCP tools.
    return {};
  }

  public async readTextFile(): Promise<acp.ReadTextFileResponse> {
    // Inert ACP filesystem stub; workspace reads are provided by MCP tools.
    return { content: "" };
  }
}

export async function createDemoSession(
  modelTurnRunner: IModelTurnRunner,
  workspaceRuntime: IWorkspaceRuntime,
  onUpdate: (params: acp.SessionNotification) => void
): Promise<DemoSession> {
  const { createWebAgent } = await import("@fledgling/web-agent");
  const streams = createConnectionStreams();
  const client = new DemoClient(onUpdate);

  new acp.AgentSideConnection(
    (connection) =>
      createWebAgent(connection, {
        modelTurnRunner,
        workspaceRuntime
      }),
    streams.agent
  );

  const connection = new acp.ClientSideConnection(() => client, streams.client);
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  });
  const session = await connection.newSession({
    cwd: "/browser",
    mcpServers: []
  });

  return {
    connection,
    protocolVersion: String(init.protocolVersion),
    sessionId: session.sessionId
  };
}

export async function createDemoWorkspace(provider: DemoWorkspaceProvider): Promise<IWorkspaceRuntime> {
  if (provider === "webcontainer") {
    return createWebContainerDemoWorkspace();
  }

  return createNodepodDemoWorkspace();
}

async function createNodepodDemoWorkspace(): Promise<IWorkspaceRuntime> {
  const { createNodepodWorkspaceRuntime } = await import("@fledgling/workspace-nodepod");
  return createNodepodWorkspaceRuntime({
    files: {
      "/README.md":
        "# Fledgling browser workspace\n\nThis workspace is backed by NodePod. Try asking the agent to list files, write notes.txt, run pwd, or write and execute a Node script.\n",
      "/package.json": JSON.stringify(
        {
          name: "fledgling-browser-workspace",
          private: true,
          type: "module",
          scripts: {
            hello: "node index.js"
          }
        },
        undefined,
        2
      ),
      "/index.js": "console.log('hello from NodePod');\n"
    },
    workdir: "/"
  });
}

async function createWebContainerDemoWorkspace(): Promise<IWorkspaceRuntime> {
  const [{ WebContainer }, { WebContainerWorkspaceRuntime }] = await Promise.all([
    import("@webcontainer/api"),
    import("@fledgling/mcp-workspace-webcontainer")
  ]);
  const container = await WebContainer.boot();
  await container.mount({
    "README.md": {
      file: {
        contents:
          "# Fledgling browser workspace\n\nThis workspace is backed by WebContainer. Try asking the agent to list files, write notes.txt, or run pwd.\n"
      }
    },
    "package.json": {
      file: {
        contents: JSON.stringify(
          {
            name: "fledgling-browser-workspace",
            private: true,
            type: "module",
            scripts: {
              hello: "echo hello from WebContainer"
            }
          },
          undefined,
          2
        )
      }
    }
  });

  return new WebContainerWorkspaceRuntime(container);
}

function createConnectionStreams(): { readonly client: acp.Stream; readonly agent: acp.Stream } {
  const clientToAgent = new TransformStream<unknown, unknown>();
  const agentToClient = new TransformStream<unknown, unknown>();

  return {
    client: {
      writable: clientToAgent.writable,
      readable: agentToClient.readable
    } as acp.Stream,
    agent: {
      writable: agentToClient.writable,
      readable: clientToAgent.readable
    } as acp.Stream
  };
}
