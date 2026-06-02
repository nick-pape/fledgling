import { promises as fs } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { estimateTokens, hashText, inferRoutingTag } from "@fledgling/common";
import {
  contextHintForFile,
  toolMeta,
  toolResult
} from "../shared/context.js";
import { fileExists } from "../shared/fs.js";
import {
  fileIdentity,
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from "../shared/workspace.js";

export function registerWriteFileTool(server: McpServer): void {
  server.registerTool(
    "workspace.write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a UTF-8 file. Use create_only for new files or overwrite_if_hash_matches with expectedHash.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        mode: z.enum(["create_only", "overwrite_if_hash_matches"]),
        expectedHash: z.string().optional()
      },
      annotations: {
        destructiveHint: true
      },
      _meta: toolMeta("mutation", true, "retain_until_changed")
    },
    async ({ path: requestedPath, content, mode, expectedHash }) => {
      const absolutePath = resolveWorkspacePath(requestedPath);
      const exists = await fileExists(absolutePath);

      if (mode === "create_only" && exists) {
        throw new Error(`File already exists: ${requestedPath}`);
      }

      if (mode === "overwrite_if_hash_matches") {
        if (!expectedHash) {
          throw new Error("expectedHash is required for overwrite_if_hash_matches.");
        }

        const current = exists ? await fs.readFile(absolutePath, "utf8") : "";
        const currentHash = hashText(current);
        if (currentHash !== expectedHash) {
          throw new Error(`File changed since last read. Expected ${expectedHash}; current ${currentHash}.`);
        }
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");

      const contentHash = hashText(content);
      const relativePath = toWorkspaceRelativePath(absolutePath);
      const contextHint = contextHintForFile(
        fileIdentity(absolutePath),
        contentHash,
        estimateTokens(content),
        ["file", inferRoutingTag(relativePath)]
      );

      return toolResult(
        `Wrote ${relativePath}. New hash ${contentHash}.`,
        {
          path: relativePath,
          contentHash,
          sizeBytes: Buffer.byteLength(content, "utf8"),
          contextHint
        },
        contextHint
      );
    }
  );
}
