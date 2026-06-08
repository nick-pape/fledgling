/* eslint-disable @rushstack/typedef-var, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { Nodepod, type NodepodOptions, type NodepodProcess } from "@scelar/nodepod";
import {
  appendSearchMatches,
  joinAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspacePath,
  type CommandResult,
  type IWorkspaceRuntime,
  type SearchMatch,
  type WorkspaceEntry
} from "@fledgling/mcp-workspace-browser";

const SKIPPED_SEARCH_DIRECTORIES = new Set(["node_modules", ".git", ".cache", "dist", "lib", "coverage", "temp"]);

export interface NodepodWorkspaceRuntimeOptions {
  readonly files?: Record<string, string | Uint8Array>;
  readonly workdir?: string;
  readonly serviceWorker?: boolean;
  readonly onServerReady?: (port: number, url: string) => void;
}

export class NodepodWorkspaceRuntime implements IWorkspaceRuntime {
  readonly #nodepod: Pick<Nodepod, "fs" | "spawn" | "teardown">;

  public constructor(nodepod: Pick<Nodepod, "fs" | "spawn" | "teardown">) {
    this.#nodepod = nodepod;
  }

  public async readFile(path: string): Promise<string> {
    return this.#nodepod.fs.readFile(normalizeAbsoluteWorkspacePath(path), "utf8");
  }

  public async writeFile(path: string, content: string): Promise<void> {
    const target = normalizeAbsoluteWorkspacePath(path);
    await this.#ensureParentDirectory(target);
    await this.#nodepod.fs.writeFile(target, content);
  }

  public async listDirectory(path: string): Promise<WorkspaceEntry[]> {
    const root = normalizeAbsoluteWorkspacePath(path);
    const entries = await this.#nodepod.fs.readdir(root);
    const result: WorkspaceEntry[] = [];

    for (const name of entries) {
      const entryPath = joinAbsoluteWorkspacePath(root, name);
      const stat = await this.#nodepod.fs.stat(entryPath);
      const relativePath = normalizeWorkspacePath(entryPath);
      if (stat.isDirectory) {
        result.push({
          type: "directory",
          name,
          path: relativePath
        });
        continue;
      }

      result.push({
        type: "file",
        name,
        path: relativePath,
        sizeBytes: stat.size
      });
    }

    return result;
  }

  public async searchText(query: string, path: string): Promise<readonly SearchMatch[]> {
    const matches: SearchMatch[] = [];
    await this.#searchDirectory(normalizeAbsoluteWorkspacePath(path), query, matches);
    return matches;
  }

  public async runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<CommandResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    let stdout = "";
    let stderr = "";

    try {
      const process = await this.#nodepod.spawn(command, [], {
        cwd: normalizeAbsoluteWorkspacePath(cwd),
        signal: abortController.signal
      });
      process.on("output", (chunk: string) => {
        stdout = appendLimited(stdout, chunk, maxOutputBytes);
      });
      process.on("error", (chunk: string) => {
        stderr = appendLimited(stderr, chunk, maxOutputBytes);
      });

      const result = await process.completion;
      stdout = stdout || result.stdout.slice(0, maxOutputBytes);
      stderr = stderr || result.stderr.slice(0, maxOutputBytes);

      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        timedOut: abortController.signal.aborted,
        truncated: result.stdout.length > stdout.length || result.stderr.length > stderr.length
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  public dispose(): void {
    this.#nodepod.teardown();
  }

  async #searchDirectory(path: string, query: string, matches: SearchMatch[]): Promise<void> {
    for (const name of await this.#nodepod.fs.readdir(path)) {
      if (SKIPPED_SEARCH_DIRECTORIES.has(name)) {
        continue;
      }

      const entryPath = joinAbsoluteWorkspacePath(path, name);
      const stat = await this.#nodepod.fs.stat(entryPath);
      if (stat.isDirectory) {
        await this.#searchDirectory(entryPath, query, matches);
        continue;
      }

      const content = await this.#nodepod.fs.readFile(entryPath, "utf8");
      appendSearchMatches(matches, normalizeWorkspacePath(entryPath), content, query);
    }
  }

  async #ensureParentDirectory(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await this.#nodepod.fs.mkdir(parent, { recursive: true });
  }
}

export async function createNodepodWorkspaceRuntime(
  options: NodepodWorkspaceRuntimeOptions = {}
): Promise<NodepodWorkspaceRuntime> {
  const nodepod = await Nodepod.boot({
    files: options.files,
    workdir: options.workdir ?? "/",
    serviceWorker: options.serviceWorker,
    onServerReady: options.onServerReady,
    watermark: false
  });
  return new NodepodWorkspaceRuntime(nodepod);
}

function appendLimited(current: string, chunk: string, maxLength: number): string {
  if (current.length >= maxLength) {
    return current;
  }

  return `${current}${chunk}`.slice(0, maxLength);
}

export type { NodepodOptions, NodepodProcess };
