export const DEFAULT_MAX_READ_BYTES: number = 256 * 1024;
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES: number = 64 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS: number = 30_000;
export const DEFAULT_SEARCH_LIMIT: number = 50;
export const DEFAULT_MAX_FILE_SIZE_FOR_SEARCH: number = 512 * 1024;

export const DEFAULT_EXCLUDED_DIRS: Set<string> = new Set([
  ".git",
  ".rush",
  ".heft",
  "common",
  "dist",
  "lib",
  "node_modules",
  "temp"
]);
