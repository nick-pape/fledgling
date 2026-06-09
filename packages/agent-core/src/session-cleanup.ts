import type { IClosable, IRuntimeLogger } from "./interfaces.js";

export interface PromptAbortControllerLike {
  abort(): void;
}

export interface SessionCleanupState {
  readonly id: string;
  readonly clients: readonly IClosable[];
  readonly pendingPrompt: PromptAbortControllerLike | undefined;
}

export interface McpCloseFailureRecord {
  readonly level: "warn";
  readonly event: "mcp_close_failed";
  readonly sessionId: string | undefined;
  readonly reason: string;
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

export class SessionCleanup {
  readonly #getSessions: () => Iterable<SessionCleanupState>;
  readonly #clearSessions: () => void;
  readonly #logger: IRuntimeLogger;
  #closeAllPromise: Promise<void> | undefined;

  public constructor(
    getSessions: () => Iterable<SessionCleanupState>,
    clearSessions: () => void,
    logger: IRuntimeLogger = defaultLogger
  ) {
    this.#getSessions = getSessions;
    this.#clearSessions = clearSessions;
    this.#logger = logger;
  }

  public closeAll(reason: string): Promise<void> {
    this.#closeAllPromise ??= this.#closeAll(reason);
    return this.#closeAllPromise;
  }

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
