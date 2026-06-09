import { describe, expect, it, vi } from "vitest";

import { WebContainerWorkspaceRuntime } from "./runtime.js";

class FakeDirent {
  public readonly name: string;
  readonly #directory: boolean;

  public constructor(name: string, directory: boolean) {
    this.name = name;
    this.#directory = directory;
  }

  public isDirectory(): boolean {
    return this.#directory;
  }
}

describe("WebContainerWorkspaceRuntime", () => {
  it("normalizes paths for file and directory operations", async () => {
    const reads: string[] = [];
    const writes: [string, string][] = [];
    const runtime = new WebContainerWorkspaceRuntime({
      fs: {
        async readFile(path: string): Promise<string> {
          reads.push(path);
          return `content:${path}`;
        },
        async writeFile(path: string, content: string): Promise<void> {
          writes.push([path, content]);
        },
        async readdir(path: string): Promise<FakeDirent[]> {
          expect(path).toBe(".");
          return [new FakeDirent("src", true), new FakeDirent("README.md", false)];
        }
      }
    } as never);

    await expect(runtime.readFile("/src\\index.ts")).resolves.toBe("content:src/index.ts");
    await runtime.writeFile("/README.md", "hello");
    await expect(runtime.listDirectory("/")).resolves.toEqual([
      { type: "directory", name: "src", path: "src" },
      { type: "file", name: "README.md", path: "README.md", sizeBytes: 0 }
    ]);

    expect(reads).toEqual(["src/index.ts"]);
    expect(writes).toEqual([["README.md", "hello"]]);
  });

  it("searches nested text files", async () => {
    const files = new Map<string, string>([
      ["README.md", "hello\nneedle here"],
      ["src/index.ts", "export const value = 'needle';"]
    ]);
    const directories = new Map<string, FakeDirent[]>([
      [".", [new FakeDirent("src", true), new FakeDirent("README.md", false)]],
      ["src", [new FakeDirent("index.ts", false)]]
    ]);
    const runtime = new WebContainerWorkspaceRuntime({
      fs: {
        async readFile(path: string): Promise<string> {
          return files.get(path) ?? "";
        },
        async writeFile(): Promise<void> {},
        async readdir(path: string): Promise<FakeDirent[]> {
          return directories.get(path) ?? [];
        }
      }
    } as never);

    await expect(runtime.searchText("needle", ".")).resolves.toEqual([
      { path: "src/index.ts", line: 1, text: "export const value = 'needle';" },
      { path: "README.md", line: 2, text: "needle here" }
    ]);
  });

  it("aborts commands that exceed the timeout", async () => {
    const kill = vi.fn();
    const runtime = new WebContainerWorkspaceRuntime({
      fs: {
        async readFile(): Promise<string> {
          return "";
        },
        async writeFile(): Promise<void> {},
        async readdir(): Promise<FakeDirent[]> {
          return [];
        }
      },
      async spawn(): Promise<unknown> {
        return {
          output: new ReadableStream<string>(),
          exit: new Promise<number>(() => undefined),
          kill
        };
      }
    } as never);

    await expect(runtime.runCommand("sleep 10", ".", 1, 1000)).resolves.toEqual({
      exitCode: 124,
      stdout: "",
      stderr: "Command timed out",
      timedOut: true,
      truncated: false
    });
    expect(kill).toHaveBeenCalledOnce();
  });
});
