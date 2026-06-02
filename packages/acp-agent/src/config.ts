import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface FledglingConfig {
  readonly mcpServers?: Record<string, McpServerConfig>;
}

export type McpOrigin = "acp_client" | "config" | "first_party";

export interface ResolvedMcpServer {
  readonly name: string;
  readonly origin: McpOrigin;
  readonly config: McpServerConfig;
}

export type McpServerConfig =
  | {
      readonly type: "firstPartyWorkspace";
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: string[];
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers?: Record<string, string>;
    };

export async function loadConfig(): Promise<FledglingConfig> {
  const configPath = process.env.FLEDGLING_CONFIG
    ? path.resolve(process.env.FLEDGLING_CONFIG)
    : path.resolve(process.cwd(), "fledgling.config.json");

  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(await readFile(configPath, "utf8")) as FledglingConfig;
}
