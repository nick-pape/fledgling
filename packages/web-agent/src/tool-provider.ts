import {
  experimental_createMCPClient as createMCPClient,
  type experimental_MCPClient as MCPClient,
  type MCPTransport
} from "@ai-sdk/mcp";
import type { IToolProvider, SessionTools } from "@fledgling/agent-core";
import type * as acp from "@agentclientprotocol/sdk";
import type { WebWorkspaceSidecar } from "@fledgling/mcp-workspace-webcontainer";
import type { ToolSet } from "ai";

export interface WebMcpToolProviderOptions {
  readonly createSidecar: () => Promise<WebWorkspaceSidecar>;
}

class WebMcpClientHandle {
  readonly #client: MCPClient;
  readonly #sidecar: WebWorkspaceSidecar;

  public constructor(client: MCPClient, sidecar: WebWorkspaceSidecar) {
    this.#client = client;
    this.#sidecar = sidecar;
  }

  public async close(): Promise<void> {
    await this.#client.close();
    await this.#sidecar.close();
  }
}

export class WebMcpToolProvider implements IToolProvider {
  readonly #createSidecar: () => Promise<WebWorkspaceSidecar>;

  public constructor(options: WebMcpToolProviderOptions) {
    this.#createSidecar = options.createSidecar;
  }

  public async createSessionTools(_request: {
    readonly cwd: string | undefined;
    readonly mcpServers: acp.McpServer[];
  }): Promise<SessionTools> {
    const sidecar = await this.#createSidecar();
    const client = await createMCPClient({
      name: "fledgling-web-agent",
      transport: sidecar.clientTransport as MCPTransport
    });
    const tools: ToolSet = await client.tools();

    return {
      clients: [new WebMcpClientHandle(client, sidecar)],
      tools
    };
  }
}
