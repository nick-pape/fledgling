import {
  experimental_createMCPClient as createMCPClient,
  type experimental_MCPClient as MCPClient,
  type MCPTransport
} from "@ai-sdk/mcp";
import type { IToolProvider, SessionTools } from "@fledgling/agent-core";
import type * as acp from "@agentclientprotocol/sdk";
import type { WebWorkspaceSidecar } from "@fledgling/mcp-workspace-browser";
import type { ToolSet } from "ai";

/**
 * Options for configuring a {@link WebMcpToolProvider}.
 *
 * @public
 */
export interface WebMcpToolProviderOptions {
  /**
   * Creates the browser workspace sidecar used to host MCP tools for a session.
   */
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

/**
 * Provides MCP workspace tools backed by a browser sidecar.
 *
 * @public
 */
export class WebMcpToolProvider implements IToolProvider {
  readonly #createSidecar: () => Promise<WebWorkspaceSidecar>;

  /**
   * Creates a browser MCP tool provider.
   *
   * @param options - Sidecar factory used when session tools are requested.
   */
  public constructor(options: WebMcpToolProviderOptions) {
    this.#createSidecar = options.createSidecar;
  }

  /**
   * Creates MCP clients and AI SDK tools for an agent session.
   *
   * @param _request - Session context supplied by the agent core.
   * @returns MCP clients and tools that should be closed when the session ends.
   */
  public async createSessionTools(_request: {
    readonly cwd: string | undefined;
    readonly mcpServers: acp.McpServer[];
  }): Promise<SessionTools> {
    const sidecar = await this.#createSidecar();
    let client: MCPClient | undefined;

    try {
      client = await createMCPClient({
        name: "fledgling-web-agent",
        transport: sidecar.clientTransport as MCPTransport
      });
      const tools: ToolSet = await client.tools();

      return {
        clients: [new WebMcpClientHandle(client, sidecar)],
        tools
      };
    } catch (error: unknown) {
      await client?.close();
      await sidecar.close();
      throw error;
    }
  }
}
