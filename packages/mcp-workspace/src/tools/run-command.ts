import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES
} from "../shared/constants.js";
import {
  type ContextHint,
  estimateTokens,
  hashText,
  toolMeta,
  toolResult
} from "../shared/context.js";
import { runCommand } from "../shared/command.js";
import { resolveWorkspacePath, toWorkspaceRelativePath } from "../shared/workspace.js";

export function registerRunCommandTool(server: McpServer): void {
  server.registerTool(
    "workspace.run_command",
    {
      title: "Run command",
      description:
        "Run a non-interactive shell command in the workspace. Output is truncated and retained only as latest evidence.",
      inputSchema: {
        command: z.string(),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().positive().default(DEFAULT_COMMAND_TIMEOUT_MS),
        maxOutputBytes: z.number().int().positive().default(DEFAULT_MAX_COMMAND_OUTPUT_BYTES)
      },
      annotations: {
        destructiveHint: true
      },
      _meta: toolMeta("execution", true, "discard_after_turn")
    },
    async ({ command, cwd, timeoutMs, maxOutputBytes }) => {
      const absoluteCwd = resolveWorkspacePath(cwd);
      const started = Date.now();
      const result = await runCommand(command, absoluteCwd, timeoutMs, maxOutputBytes);
      const durationMs = Date.now() - started;
      const output = `exitCode: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      const contextHint = {
        kind: "command_output",
        identity: `command://${hashText(`${absoluteCwd}\n${command}`)}`,
        contentHash: hashText(output),
        tokenEstimate: estimateTokens(output),
        placement: "latest_evidence",
        retention: "discard_after_turn",
        priority: 90,
        routingTags: ["command", "shell"]
      } satisfies ContextHint;

      return toolResult(
        `Command completed in ${durationMs}ms with exit code ${result.exitCode}.\n\n${output}`,
        {
          command,
          cwd: toWorkspaceRelativePath(absoluteCwd),
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs,
          truncated: result.truncated,
          timedOut: result.timedOut,
          contextHint
        },
        contextHint
      );
    }
  );
}
