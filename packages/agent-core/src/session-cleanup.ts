import type { IClosable, IRuntimeLogger } from "./interfaces.js";

/** Minimal abort controller contract used for pending prompts. */
export interface PromptAbortControllerLike {
  /** Aborts the pending prompt. */
  abort(): void;
}

/** Session state required by cleanup helpers. */
export interface SessionCleanupState {
  /** Session identifier used in cleanup diagnostics. */
  readonly id: string;

  /** Closeable clients owned by the session. */
  readonly clients: readonly IClosable[];

  /** Active prompt abort controller, when a prompt is running. */
  readonly pendingPrompt: PromptAbortControllerLike | undefined;
}

/** Structured warning emitted when an MCP client fails to close. */
export interface McpCloseFailureRecord {
  /** Log severity for the record. */
  readonly level: "warn";

  /** Event name for MCP close failures. */
  readonly event: "mcp_close_failed";

  /** Session identifier associated with the close attempt, when known. */
  readonly sessionId: string | undefined;

  /** Reason the close operation was requested. */
  readonly reason: string;

  /** Serialized close failure. */
  readonly error: string;
}

const defaultLogger: IRuntimeLogger = {
  warn(record: unknown): void {
    console.warn(JSON.stringify(record));
  },
  error(record: unknown): void {
    console.error(JSON.stringify(record));
  }
};

/** Coordinates prompt cancellation and client cleanup for active sessions. */
export class SessionCleanup {
  readonly #getSessions: () => Iterable<SessionCleanupState>;
  readonly #clearSessions: () => void;
  readonly #logger: IRuntimeLogger;
  #closeAllPromise: Promise<void> | undefined;

  /** Creates a cleanup helper over caller-owned session storage. */
  public constructor(
    getSessions: () => Iterable<SessionCleanupState>,
    clearSessions: () => void,
    logger: IRuntimeLogger = defaultLogger
  ) {
    this.#getSessions = getSessions;
    this.#clearSessions = clearSessions;
    this.#logger = logger;
  }

  /** Closes all current sessions once, reusing the same promise for concurrent callers. */
  public closeAll(reason: string): Promise<void> {
    this.#closeAllPromise ??= this.#closeAll(reason);
    return this.#closeAllPromise;
  }

  /** Aborts and closes the resources for a single session. */
  public async closeSession(session: SessionCleanupState, reason: string): Promise<void> {
    session.pendingPrompt?.abort();
    await closeClients(session.clients, reason, session.id, this.#logger);
  }

  async #closeAll(reason: string): Promise<void> {
    const closeAttempts: Promise<void>[] = [];

    for (const session of this.#getSessions()) {
      closeAttempts.push(this.closeSession(session, reason));
    }

    await Promise.allSettled(closeAttempts);
    this.#clearSessions();
  }
}

/** Closes a set of clients and logs individual close failures. */
export async function closeClients(
  clients: readonly IClosable[],
  reason: string,
  sessionId: string | undefined = undefined,
  logger: IRuntimeLogger = defaultLogger
): Promise<void> {
  await Promise.allSettled(
    clients.map(async (client) => {
      try {
        await client.close();
      } catch (error: unknown) {
        logger.warn({
          level: "warn",
          event: "mcp_close_failed",
          sessionId,
          reason,
          error: serializeError(error)
        } satisfies McpCloseFailureRecord);
      }
    })
  );
}

/** Converts an unknown error value into a loggable string. */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    const serialized: unknown = JSON.stringify(error);
    return typeof serialized === "string" ? serialized : String(error);
  } catch {
    return String(error);
  }
}
