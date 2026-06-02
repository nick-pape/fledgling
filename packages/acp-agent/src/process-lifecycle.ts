import { serializeError } from "./session-cleanup.js";

export interface ShutdownAgent {
  closeAllSessions(reason: string): Promise<void>;
}

export function registerProcessLifecycle(getActiveAgent: () => ShutdownAgent | undefined): void {
  let shutdownPromise: Promise<void> | undefined;

  function shutdownAgent(reason: string): Promise<void> {
    shutdownPromise ??= getActiveAgent()?.closeAllSessions(reason) ?? Promise.resolve();
    return shutdownPromise;
  }

  async function shutdownAndExit(reason: string, exitCode: number): Promise<void> {
    await shutdownAgent(reason);
    process.exit(exitCode);
  }

  function logFatal(event: string, error: unknown): void {
    console.error(
      JSON.stringify({
        level: "error",
        event,
        error: serializeError(error)
      })
    );
  }

  process.once("SIGINT", () => {
    shutdownAndExit("SIGINT", 130).catch((error: unknown) => {
      logFatal("shutdown_failed", error);
      process.exit(1);
    });
  });

  process.once("SIGTERM", () => {
    shutdownAndExit("SIGTERM", 143).catch((error: unknown) => {
      logFatal("shutdown_failed", error);
      process.exit(1);
    });
  });

  process.once("beforeExit", () => {
    shutdownAgent("beforeExit").catch((error: unknown) => {
      logFatal("shutdown_failed", error);
    });
  });

  process.once("uncaughtException", (error: Error) => {
    logFatal("uncaught_exception", error);
    shutdownAndExit("uncaughtException", 1).catch((shutdownError: unknown) => {
      logFatal("shutdown_failed", shutdownError);
      process.exit(1);
    });
  });

  process.once("unhandledRejection", (reason: unknown) => {
    logFatal("unhandled_rejection", reason);
    shutdownAndExit("unhandledRejection", 1).catch((error: unknown) => {
      logFatal("shutdown_failed", error);
      process.exit(1);
    });
  });
}
