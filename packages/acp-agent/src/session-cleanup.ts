export interface McpClientLike {
  close(): Promise<void> | void;
}

export interface PromptAbortControllerLike {
  abort(): void;
}

export interface SessionCleanupState {
  readonly id: string;
  readonly mcpClients: readonly McpClientLike[];
  readonly pendingPrompt: PromptAbortControllerLike | undefined;
}

export interface McpCloseFailureRecord {
  readonly level: "warn";
  readonly event: "mcp_close_failed";
  readonly sessionId: string;
  readonly reason: string;
  readonly error: string;
}

type WarnLogger = (record: McpCloseFailureRecord) => void;

export class SessionCleanup {
  readonly #getSessions: () => Iterable<SessionCleanupState>;
  readonly #clearSessions: () => void;
  readonly #logWarn: WarnLogger;
  #closeAllPromise: Promise<void> | undefined;

  public constructor(
    getSessions: () => Iterable<SessionCleanupState>,
    clearSessions: () => void,
    logWarn: WarnLogger = defaultWarnLogger
  ) {
    this.#getSessions = getSessions;
    this.#clearSessions = clearSessions;
    this.#logWarn = logWarn;
  }

  public closeAll(reason: string): Promise<void> {
    this.#closeAllPromise ??= this.#closeAll(reason);
    return this.#closeAllPromise;
  }

  async #closeAll(reason: string): Promise<void> {
    const closeAttempts: Promise<void>[] = [];

    for (const session of this.#getSessions()) {
      session.pendingPrompt?.abort();

      closeAttempts.push(
        ...session.mcpClients.map(async (client) => {
          try {
            await client.close();
          } catch (error: unknown) {
            this.#logWarn({
              level: "warn",
              event: "mcp_close_failed",
              sessionId: session.id,
              reason,
              error: serializeError(error)
            });
          }
        })
      );
    }

    await Promise.allSettled(closeAttempts);
    this.#clearSessions();
  }
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

function defaultWarnLogger(record: McpCloseFailureRecord): void {
  console.error(JSON.stringify(record));
}
