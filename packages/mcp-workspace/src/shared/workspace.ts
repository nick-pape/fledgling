import path from "node:path";
import { pathToFileURL } from "node:url";

export const workspaceRoot = path.resolve(process.env.FLEDGLING_WORKSPACE_ROOT ?? process.cwd());

export function resolveWorkspacePath(requestedPath: string): string {
  const absolutePath = path.resolve(workspaceRoot, requestedPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return absolutePath;
  }

  throw new Error(`Path escapes workspace root: ${requestedPath}`);
}

export function toWorkspaceRelativePath(absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

export function fileIdentity(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}
