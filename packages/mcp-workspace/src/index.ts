#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerWorkspaceTools } from "./tools/index.js";

const server: McpServer = new McpServer(
  {
    name: "fledgling-workspace",
    version: "0.0.0"
  },
  {
    instructions:
      "Workspace tools return Fledgling context hints in structuredContent.contextHint and _meta['house.pape.fledgling/context-hint']. Prefer read_file before editing; mutation tools require expectedHash."
  }
);

registerWorkspaceTools(server);

await server.connect(new StdioServerTransport());
