import { defineConfig, mergeConfig } from "vitest/config";

const baseConfig = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
    isolate: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      clean: true
    }
  }
});

export function createVitestConfig(overrides) {
  if (!overrides) {
    return baseConfig;
  }

  return mergeConfig(baseConfig, defineConfig(overrides));
}
