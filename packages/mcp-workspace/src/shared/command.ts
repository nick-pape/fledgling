import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const next = stdout + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        truncated = true;
        stdout = truncateToBytes(next, maxOutputBytes);
      } else {
        stdout = next;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const next = stderr + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        truncated = true;
        stderr = truncateToBytes(next, maxOutputBytes);
      } else {
        stderr = next;
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? undefined,
        stdout,
        stderr,
        truncated,
        timedOut
      });
    });
  });
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }

  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}
