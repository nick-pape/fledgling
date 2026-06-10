/* eslint-disable @typescript-eslint/explicit-member-accessibility, @typescript-eslint/typedef */
import { describe, expect, it, vi } from "vitest";

import { NodepodWorkspaceRuntime } from "./runtime.js";

class FakeProcess {
  readonly completion: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readonly #handlers = new Map<string, (chunk: string) => void>();

  public constructor(result: { stdout: string; stderr: string; exitCode: number }) {
    this.completion = Promise.resolve(result);
  }

  public on(event: "output" | "error" | "exit", handler: (chunk: string) => void): this {
    this.#handlers.set(event, handler);
    return this;
  }
}

describe("NodepodWorkspaceRuntime", () => {
  it("normalizes paths for filesystem operations", async () => {
    const reads: string[] = [];
    const writes: [string, string][] = [];
    const mkdirs: string[] = [];
    const runtime = new NodepodWorkspaceRuntime({
      fs: {
        async readFile(path: string): Promise<string> {
          reads.push(path);
          return `content:${path}`;
        },
        async writeFile(path: string, content: string): Promise<void> {
          writes.push([path, content]);
        },
        async mkdir(path: string): Promise<void> {
          mkdirs.push(path);
        },
        async readdir(): Promise<string[]> {
          return ["src", "README.md"];
        },
        async stat(path: string): Promise<{ isDirectory: boolean; size: number }> {
          return { isDirectory: path.endsWith("/src"), size: 12 };
        }
      },
      async spawn(): Promise<FakeProcess> {
        return new FakeProcess({ stdout: "", stderr: "", exitCode: 0 });
      },
      teardown: vi.fn()
    } as never);

    await expect(runtime.readFile("/src\\index.ts")).resolves.toBe("content:/src/index.ts");
    await runtime.writeFile("/src\\index.ts", "hello");
    await expect(runtime.listDirectory("/")).resolves.toEqual([
      { type: "directory", name: "src", path: "src" },
      { type: "file", name: "README.md", path: "README.md", sizeBytes: 12 }
    ]);

    expect(reads).toEqual(["/src/index.ts"]);
    expect(mkdirs).toEqual(["/src"]);
    expect(writes).toEqual([["/src/index.ts", "hello"]]);
  });

  it("runs commands through the NodePod shell", async () => {
    const runs: unknown[] = [];
    const runtime = new NodepodWorkspaceRuntime({
      fs: {},
      async run(...args: unknown[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        runs.push(args);
        return { stdout: "hello\n", stderr: "", exitCode: 0 };
      },
      async spawn(...args: unknown[]): Promise<FakeProcess> {
        return new FakeProcess({ stdout: "hello\n", stderr: "", exitCode: 0 });
      },
      teardown: vi.fn()
    } as never);

    await expect(runtime.runCommand("node index.js | cat", ".", 1000, 20)).resolves.toEqual({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timedOut: false,
      truncated: false
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject(["node index.js | cat", { cwd: "/" }]);
  });
});
