import type { WebContainer } from "@webcontainer/api";
import {
  appendSearchMatches,
  joinWorkspacePath,
  normalizeWorkspacePath,
  type CommandResult,
  type IWorkspaceRuntime,
  type SearchMatch,
  type WorkspaceEntry
} from "@fledgling/mcp-workspace-browser";

/**
 * Workspace runtime adapter backed by a WebContainer instance.
 */
export class WebContainerWorkspaceRuntime implements IWorkspaceRuntime {
  readonly #container: WebContainer;

  /**
   * Creates a runtime that reads, writes, lists, searches, and runs commands in the provided container.
   */
  public constructor(container: WebContainer) {
    this.#container = container;
  }

  /**
   * Reads a UTF-8 text file from the workspace.
   */
  public async readFile(path: string): Promise<string> {
    return this.#container.fs.readFile(normalizeWorkspacePath(path), "utf8");
  }

  /**
   * Writes UTF-8 text content to a workspace file.
   */
  public async writeFile(path: string, content: string): Promise<void> {
    await this.#container.fs.writeFile(normalizeWorkspacePath(path), content);
  }

  /**
   * Lists immediate children of a workspace directory.
   */
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

  /**
   * Searches workspace text files under a directory for an exact query string.
   */
  public async searchText(query: string, path: string): Promise<readonly SearchMatch[]> {
    const matches: SearchMatch[] = [];
    await this.#searchDirectory(normalizeWorkspacePath(path), query, matches);
    return matches;
  }

  /**
   * Runs a shell command from a workspace directory.
   */
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

  let removeAbortListener: () => void = () => undefined;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    const onAbort = (): void => reject(new DOMException("Command timed out", "AbortError"));
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
  });

  return Promise.race([promise, abortPromise]).finally(() => removeAbortListener());
}

function killProcess(process: unknown): void {
  const candidate = process as { kill?: () => void };
  candidate.kill?.();
}
