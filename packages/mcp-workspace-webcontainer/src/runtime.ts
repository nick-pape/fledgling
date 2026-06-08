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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const process = await this.#container.spawn("jsh", ["-c", command], {
        cwd: normalizeWorkspacePath(cwd)
      });
      try {
        const stdout = await readProcessOutput(process.output, maxOutputBytes, controller.signal);
        const exitCode = await waitForProcessExit(process.exit, controller.signal);

        return {
          exitCode,
          stdout,
          stderr: "",
          timedOut: false,
          truncated: stdout.length >= maxOutputBytes
        };
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          throw error;
        }

        killProcess(process);
        return {
          exitCode: 124,
          stdout: "",
          stderr: "Command timed out",
          timedOut: true,
          truncated: false
        };
      }
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

async function readProcessOutput(
  output: ReadableStream<string>,
  maxOutputBytes: number,
  abortSignal: AbortSignal
): Promise<string> {
  let text = "";
  const reader = output.getReader();

  try {
    for (;;) {
      const result = await readWithAbort(reader, abortSignal);
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

function waitForProcessExit(exit: Promise<number>, abortSignal: AbortSignal): Promise<number> {
  return raceAbort(exit, abortSignal);
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<string>,
  abortSignal: AbortSignal
): Promise<ReadableStreamReadResult<string>> {
  if (abortSignal.aborted) {
    throw new DOMException("Command timed out", "AbortError");
  }

  return raceAbort(reader.read(), abortSignal);
}

function raceAbort<T>(promise: Promise<T>, abortSignal: AbortSignal): Promise<T> {
  if (abortSignal.aborted) {
    return Promise.reject(new DOMException("Command timed out", "AbortError"));
  }

  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(new DOMException("Command timed out", "AbortError")), {
        once: true
      });
    })
  ]);
}

function killProcess(process: unknown): void {
  const candidate = process as { kill?: () => void };
  candidate.kill?.();
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
