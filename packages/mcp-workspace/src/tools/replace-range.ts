import { promises as fs } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  contextHintForFile,
  estimateTokens,
  hashText,
  inferRoutingTag,
  toolMeta,
  toolResult
} from "../shared/context.js";
import {
  fileIdentity,
  resolveWorkspacePath,
  toWorkspaceRelativePath
} from "../shared/workspace.js";

export function registerReplaceRangeTool(server: McpServer): void {
  server.registerTool(
    "workspace.replace_range",
    {
      title: "Replace range",
      description:
        "Replace a 1-based inclusive line range in a UTF-8 file. Requires expectedHash from a prior read_file result.",
      inputSchema: {
        path: z.string(),
        expectedHash: z.string().describe("Current file content hash from workspace.read_file."),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        replacement: z.string().describe("Replacement text for the line range.")
      },
      annotations: {
        destructiveHint: true
      },
      _meta: toolMeta("mutation", true, "retain_until_changed")
    },
    async ({ path: requestedPath, expectedHash, startLine, endLine, replacement }) => {
      if (endLine < startLine) {
        throw new Error("endLine must be greater than or equal to startLine.");
      }

      const absolutePath = resolveWorkspacePath(requestedPath);
      const original = await fs.readFile(absolutePath, "utf8");
      const originalHash = hashText(original);
      if (originalHash !== expectedHash) {
        throw new Error(`File changed since last read. Expected ${expectedHash}; current ${originalHash}.`);
      }

      const newline = original.includes("\r\n") ? "\r\n" : "\n";
      const lines = original.split(/\r?\n/);
      const hadTrailingNewline = original.endsWith("\n");
      const replacementLines = replacement.length === 0 ? [] : replacement.split(/\r?\n/);
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
      const next = lines.join(newline);
      const normalized = hadTrailingNewline && !next.endsWith(newline) ? `${next}${newline}` : next;

      await fs.writeFile(absolutePath, normalized, "utf8");
      const nextHash = hashText(normalized);
      const relativePath = toWorkspaceRelativePath(absolutePath);
      const contextHint = contextHintForFile(
        fileIdentity(absolutePath),
        nextHash,
        estimateTokens(normalized),
        ["file", inferRoutingTag(relativePath)]
      );

      return toolResult(
        `Replaced ${relativePath}:${startLine}-${endLine}. New hash ${nextHash}.`,
        {
          path: relativePath,
          previousHash: originalHash,
          contentHash: nextHash,
          startLine,
          endLine,
          contextHint
        },
        contextHint
      );
    }
  );
}
