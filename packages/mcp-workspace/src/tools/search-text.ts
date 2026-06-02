import { promises as fs } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type ContextHint,
  estimateTokens,
  hashText
} from "@fledgling/common";
import {
  DEFAULT_MAX_FILE_SIZE_FOR_SEARCH,
  DEFAULT_SEARCH_LIMIT
} from "../shared/constants.js";
import {
  type JsonRecord,
  toolMeta,
  toolResult
} from "../shared/context.js";
import { walkSearchFiles } from "../shared/fs.js";
import { resolveWorkspacePath, toWorkspaceRelativePath } from "../shared/workspace.js";

interface SearchMatch extends JsonRecord {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export function registerSearchTextTool(server: McpServer): void {
  server.registerTool(
    "workspace.search_text",
    {
      title: "Search text",
      description:
        "Search UTF-8 workspace files for a literal string. Returns matching path, line, preview, and context hints.",
      inputSchema: {
        query: z.string().min(1).describe("Literal string to search for."),
        path: z.string().default(".").describe("Directory or file to search within."),
        limit: z.number().int().positive().default(DEFAULT_SEARCH_LIMIT),
        includeHidden: z.boolean().default(false)
      },
      annotations: {
        readOnlyHint: true
      },
      _meta: toolMeta("context_fetch", true, "discard_after_turn")
    },
    async ({ query, path: requestedPath, limit, includeHidden }) => {
      const absolutePath = resolveWorkspacePath(requestedPath);
      const matches: SearchMatch[] = [];

      for await (const filePath of walkSearchFiles(absolutePath, includeHidden)) {
        if (matches.length >= limit) {
          break;
        }

        const stat = await fs.stat(filePath);
        if (stat.size > DEFAULT_MAX_FILE_SIZE_FOR_SEARCH) {
          continue;
        }

        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          if (lines[index].includes(query)) {
            matches.push({
              path: toWorkspaceRelativePath(filePath),
              line: index + 1,
              preview: lines[index].trim()
            });
          }
        }
      }

      const text = matches.map((match) => `${match.path}:${match.line}: ${match.preview}`).join("\n");
      const contextHint = {
        kind: "diagnostic",
        identity: `search://${hashText(`${requestedPath}\n${query}`)}`,
        contentHash: hashText(text),
        tokenEstimate: estimateTokens(text),
        placement: "latest_evidence",
        retention: "discard_after_turn",
        priority: 70,
        routingTags: ["search", "workspace"]
      } satisfies ContextHint;

      return toolResult(
        matches.length > 0 ? `Search results for ${JSON.stringify(query)}:\n${text}` : "No matches.",
        {
          query,
          matches,
          truncated: matches.length >= limit,
          contextHint
        },
        contextHint
      );
    }
  );
}
