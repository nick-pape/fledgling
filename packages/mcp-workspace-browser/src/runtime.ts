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
  dispose?(): Promise<void> | void;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export function appendSearchMatches(matches: SearchMatch[], path: string, content: string, query: string): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(query)) {
      matches.push({ path, line: index + 1, text: line });
    }
  }
}

export function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.length === 0 || normalized === "." ? "." : normalized;
}

export function normalizeAbsoluteWorkspacePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized === "." ? "/" : `/${normalized}`;
}

export function joinWorkspacePath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

export function joinAbsoluteWorkspacePath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}
