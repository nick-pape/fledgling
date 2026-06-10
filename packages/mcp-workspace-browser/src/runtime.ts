/**
 * A file entry returned when listing a browser workspace directory.
 */
export interface WorkspaceFileEntry {
  /**
   * Discriminator identifying this entry as a file.
   */
  readonly type: "file";

  /**
   * Base name of the file.
   */
  readonly name: string;

  /**
   * Workspace-relative path to the file.
   */
  readonly path: string;

  /**
   * Size of the file content in bytes.
   */
  readonly sizeBytes: number;
}

/**
 * A directory entry returned when listing a browser workspace directory.
 */
export interface WorkspaceDirectoryEntry {
  /**
   * Discriminator identifying this entry as a directory.
   */
  readonly type: "directory";

  /**
   * Base name of the directory.
   */
  readonly name: string;

  /**
   * Workspace-relative path to the directory.
   */
  readonly path: string;
}

/**
 * A file or directory entry in a browser workspace listing.
 */
export type WorkspaceEntry = WorkspaceFileEntry | WorkspaceDirectoryEntry;

/**
 * Result of a command executed by a browser workspace runtime.
 */
export interface CommandResult {
  /**
   * Process exit code reported by the runtime.
   */
  readonly exitCode: number;

  /**
   * Captured standard output.
   */
  readonly stdout: string;

  /**
   * Captured standard error.
   */
  readonly stderr: string;

  /**
   * Whether the command exceeded the requested timeout.
   */
  readonly timedOut: boolean;

  /**
   * Whether stdout or stderr was shortened to satisfy the requested output limit.
   */
  readonly truncated: boolean;
}

/**
 * Runtime adapter used by browser workspace MCP tools to access files and commands.
 */
export interface IWorkspaceRuntime {
  /**
   * Reads a UTF-8 text file from the workspace.
   */
  readFile(path: string): Promise<string>;

  /**
   * Writes UTF-8 text content to a workspace file.
   */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Lists immediate children of a workspace directory.
   */
  listDirectory(path: string): Promise<WorkspaceEntry[]>;

  /**
   * Searches workspace text files for an exact query string.
   */
  searchText(query: string, path: string): Promise<readonly SearchMatch[]>;

  /**
   * Runs a shell command from a workspace directory.
   */
  runCommand(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<CommandResult>;

  /**
   * Releases runtime resources when the sidecar is closed.
   */
  dispose?(): Promise<void> | void;
}

/**
 * A single text search match in a browser workspace file.
 */
export interface SearchMatch {
  /**
   * Workspace-relative path containing the match.
   */
  readonly path: string;

  /**
   * One-based line number of the match.
   */
  readonly line: number;

  /**
   * Full line of text containing the match.
   */
  readonly text: string;
}

/**
 * Appends exact line-based search matches for a file to an existing collection.
 */
export function appendSearchMatches(matches: SearchMatch[], path: string, content: string, query: string): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(query)) {
      matches.push({ path, line: index + 1, text: line });
    }
  }
}

/**
 * Normalizes a workspace-relative path to use forward slashes and `.` for the root.
 */
export function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.length === 0 || normalized === "." ? "." : normalized;
}

/**
 * Normalizes a workspace path to an absolute browser-workspace path.
 */
export function normalizeAbsoluteWorkspacePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "." ? "/" : `/${normalized}`;
}

/**
 * Joins two normalized workspace-relative path segments.
 */
export function joinWorkspacePath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

/**
 * Joins two normalized absolute browser-workspace path segments.
 */
export function joinAbsoluteWorkspacePath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}
