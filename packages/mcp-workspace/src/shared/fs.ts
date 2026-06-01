import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_EXCLUDED_DIRS } from "./constants.js";

export async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function* walkSearchFiles(
  startPath: string,
  includeHidden: boolean
): AsyncGenerator<string> {
  const stat = await fs.stat(startPath);
  if (stat.isFile()) {
    yield startPath;
    return;
  }

  const entries = await fs.readdir(startPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    if (entry.isDirectory() && DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(startPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkSearchFiles(entryPath, includeHidden);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}
