import { promises as fs } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { estimateTokens, hashText, inferRoutingTag } from "@fledgling/common";
import { DEFAULT_MAX_READ_BYTES } from "../shared/constants.js";
import {
  contextHintForFile,
  toolMeta,
  toolResult
} from "../shared/context.js";
import {
  fileIdentity,
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from "../shared/workspace.js";

export function registerReadFileTool(server: McpServer): void {
  server.registerTool(
    "workspace.read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file inside the workspace. Returns content plus path, size, content hash, token estimate, and context hints.",
      inputSchema: {
        path: z.string().describe("Workspace-relative or absolute path inside the workspace."),
        maxBytes: z.number().int().positive().optional().describe("Maximum bytes to read.")
      },
      annotations: {
        readOnlyHint: true
      },
      _meta: toolMeta("context_fetch", true, "retain_until_changed")
    },
    async ({ path: requestedPath, maxBytes }) => {
      const absolutePath = resolveWorkspacePath(requestedPath);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${requestedPath}`);
      }

      const limit = maxBytes ?? DEFAULT_MAX_READ_BYTES;
      if (stat.size > limit) {
        throw new Error(`File is ${stat.size} bytes; maxBytes is ${limit}.`);
      }

      const content = await fs.readFile(absolutePath, "utf8");
      const hash = hashText(content);
      const relativePath = toWorkspaceRelativePath(absolutePath);
      const contextHint = contextHintForFile(
        fileIdentity(absolutePath),
        hash,
        estimateTokens(content),
        ["file", inferRoutingTag(relativePath)]
      );

      return toolResult(
        `Read ${relativePath} (${stat.size} bytes, hash ${hash}).\n\n${content}`,
        {
          path: relativePath,
          uri: fileIdentity(absolutePath),
          content,
          contentHash: hash,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          tokenEstimate: estimateTokens(content),
          contextHint
        },
        contextHint
      );
    }
  );
}
