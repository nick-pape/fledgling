import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerListDirectoryTool } from "./list-directory.js";
import { registerReadFileTool } from "./read-file.js";
import { registerReplaceRangeTool } from "./replace-range.js";
import { registerRunCommandTool } from "./run-command.js";
import { registerSearchTextTool } from "./search-text.js";
import { registerWriteFileTool } from "./write-file.js";

export function registerWorkspaceTools(server: McpServer): void {
  registerReadFileTool(server);
  registerListDirectoryTool(server);
  registerSearchTextTool(server);
  registerReplaceRangeTool(server);
  registerWriteFileTool(server);
  registerRunCommandTool(server);
}
