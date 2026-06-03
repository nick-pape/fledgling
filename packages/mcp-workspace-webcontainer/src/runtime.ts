import type { WebContainer } from "@webcontainer/api";

export interface WorkspaceFileEntry {
  readonly type: "file";
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface WorkspaceDirectoryEntry {
  readonly type: "directory";
  readonly name: string;
  readonly path: string;
}

export type WorkspaceEntry = WorkspaceFileEntry | WorkspaceDirectoryEntry;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface IWorkspaceRuntime {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string): Promise<WorkspaceEntry[]>;
  searchText(query: string, path: string): Promise<readonly SearchMatch[]>;
  runCommand(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<CommandResult>;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export class WebContainerWorkspaceRuntime implements IWorkspaceRuntime {
  readonly #container: WebContainer;

  public constructor(container: WebContainer) {
    this.#container = container;
  }

  public async readFile(path: string): Promise<string> {
    return this.#container.fs.readFile(normalizeWorkspacePath(path), "utf8");
  }

  public async writeFile(path: string, content: string): Promise<void> {
    await this.#container.fs.writeFile(normalizeWorkspacePath(path), content);
  }

  public async listDirectory(path: string): Promise<WorkspaceEntry[]> {
    const root = normalizeWorkspacePath(path);
    const entries = await this.#container.fs.readdir(root, { withFileTypes: true });
    return entries.map((entry) => {
      const entryPath = joinWorkspacePath(root, entry.name);
      if (entry.isDirectory()) {
        return {
          type: "directory",
          name: entry.name,
          path: entryPath
        };
      }

      return {
        type: "file",
        name: entry.name,
        path: entryPath,
        sizeBytes: 0
      };
    });
  }

  public async searchText(query: string, path: string): Promise<readonly SearchMatch[]> {
    const matches: SearchMatch[] = [];
    await this.#searchDirectory(normalizeWorkspacePath(path), query, matches);
    return matches;
  }

  public async runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<CommandResult> {
    const started = new AbortController();
    const timeout = setTimeout(() => started.abort(), timeoutMs);

    try {
      const process = await this.#container.spawn("jsh", ["-c", command], {
        cwd: normalizeWorkspacePath(cwd)
      });
      const stdout = await readProcessOutput(process.output, maxOutputBytes);
      const exitCode = await process.exit;

      return {
        exitCode,
        stdout,
        stderr: "",
        timedOut: started.signal.aborted,
        truncated: stdout.length >= maxOutputBytes
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async #searchDirectory(path: string, query: string, matches: SearchMatch[]): Promise<void> {
    for (const entry of await this.#container.fs.readdir(path, { withFileTypes: true })) {
      const entryPath = joinWorkspacePath(path, entry.name);
      if (entry.isDirectory()) {
        await this.#searchDirectory(entryPath, query, matches);
        continue;
      }

      const content = await this.#container.fs.readFile(entryPath, "utf8");
      appendSearchMatches(matches, entryPath, content, query);
    }
  }
}

async function readProcessOutput(output: ReadableStream<string>, maxOutputBytes: number): Promise<string> {
  let text = "";
  const reader = output.getReader();

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return text.slice(0, maxOutputBytes);
      }

      text += result.value;
      if (text.length >= maxOutputBytes) {
        return text.slice(0, maxOutputBytes);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function appendSearchMatches(matches: SearchMatch[], path: string, content: string, query: string): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(query)) {
      matches.push({ path, line: index + 1, text: line });
    }
  }
}

function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.length === 0 || normalized === "." ? "." : normalized;
}

function joinWorkspacePath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}
