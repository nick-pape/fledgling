import { promises as fs } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type ContextHint,
  estimateTokens,
  hashText,
  toolMeta,
  toolResult
} from "../shared/context.js";
import { resolveWorkspacePath, toWorkspaceRelativePath } from "../shared/workspace.js";

export function registerListDirectoryTool(server: McpServer): void {
  server.registerTool(
    "workspace.list_directory",
    {
      title: "List directory",
      description:
        "List entries in a workspace directory. Returns names, kinds, sizes, mtimes, and a workspace-map context hint.",
      inputSchema: {
        path: z.string().default(".").describe("Workspace-relative or absolute directory path."),
        includeHidden: z.boolean().default(false),
        limit: z.number().int().positive().default(200)
      },
      annotations: {
        readOnlyHint: true
      },
      _meta: toolMeta("context_fetch", true, "retain_for_session")
    },
    async ({ path: requestedPath, includeHidden, limit }) => {
      const absolutePath = resolveWorkspacePath(requestedPath);
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      const listed = await Promise.all(
        entries
          .filter((entry) => includeHidden || !entry.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, limit)
          .map(async (entry) => {
            const entryPath = path.join(absolutePath, entry.name);
            const stat = await fs.stat(entryPath);
            return {
              name: entry.name,
              path: toWorkspaceRelativePath(entryPath),
              kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
              sizeBytes: stat.size,
              mtimeMs: stat.mtimeMs
            };
          })
      );

      const relativePath = toWorkspaceRelativePath(absolutePath);
      const text = listed.map((entry) => `${entry.kind}\t${entry.sizeBytes}\t${entry.path}`).join("\n");
      const contextHint = {
        kind: "workspace_map",
        identity: `workspace://${relativePath}`,
        contentHash: hashText(text),
        tokenEstimate: estimateTokens(text),
        placement: "session_context",
        retention: "retain_for_session",
        priority: 50,
        routingTags: ["directory", "workspace_map"]
      } satisfies ContextHint;

      return toolResult(
        `Directory ${relativePath}:\n${text}`,
        {
          path: relativePath,
          entries: listed,
          truncated: entries.length > listed.length,
          contextHint
        },
        contextHint
      );
    }
  );
}
