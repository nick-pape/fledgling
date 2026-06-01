export const CONTEXT_HINT_META_KEY = "house.pape.fledgling/context-hint";
export const TOOL_META_KEY = "house.pape.fledgling/tool";

export const DEFAULT_MAX_READ_BYTES = 256 * 1024;
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_SEARCH_LIMIT = 50;
export const DEFAULT_MAX_FILE_SIZE_FOR_SEARCH = 512 * 1024;

export const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  ".rush",
  ".heft",
  "common",
  "dist",
  "lib",
  "node_modules",
  "temp"
]);
