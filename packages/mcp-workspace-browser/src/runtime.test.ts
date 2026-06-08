import { describe, expect, it } from "vitest";

import {
  appendSearchMatches,
  joinAbsoluteWorkspacePath,
  joinWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspacePath
} from "./runtime.js";

describe("browser workspace path helpers", () => {
  it("normalizes relative and absolute workspace paths", () => {
    expect(normalizeWorkspacePath("/src\\index.ts")).toBe("src/index.ts");
    expect(normalizeWorkspacePath("/")).toBe(".");
    expect(normalizeAbsoluteWorkspacePath("/src\\index.ts")).toBe("/src/index.ts");
    expect(normalizeAbsoluteWorkspacePath(".")).toBe("/");
  });

  it("joins relative and absolute workspace paths", () => {
    expect(joinWorkspacePath(".", "README.md")).toBe("README.md");
    expect(joinWorkspacePath("src", "index.ts")).toBe("src/index.ts");
    expect(joinAbsoluteWorkspacePath("/", "README.md")).toBe("/README.md");
    expect(joinAbsoluteWorkspacePath("/src", "index.ts")).toBe("/src/index.ts");
  });

  it("appends line-oriented search matches", () => {
    const matches: { path: string; line: number; text: string }[] = [];
    appendSearchMatches(matches, "README.md", "hello\nneedle here", "needle");
    expect(matches).toEqual([{ path: "README.md", line: 2, text: "needle here" }]);
  });
});
