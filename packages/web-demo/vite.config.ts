import { defineConfig } from "vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id): string | undefined {
          const normalized = id.replaceAll("\\", "/");
          if (normalized.includes("react") || normalized.includes("react-dom")) {
            return "react";
          }

          if (
            normalized.includes("@monaco-editor/react") ||
            normalized.includes("/monaco-editor/")
          ) {
            return "editor";
          }

          if (
            normalized.includes("@agentclientprotocol/sdk") ||
            normalized.includes("@ai-sdk/mcp") ||
            normalized.includes("@fledgling/") ||
            normalized.includes("@modelcontextprotocol/sdk") ||
            normalized.includes("@webcontainer/api") ||
            normalized.includes("/ajv") ||
            normalized.includes("/ajv-formats") ||
            normalized.includes("/fast-uri") ||
            normalized.includes("/zod")
          ) {
            return "webagent-runtime";
          }

          return undefined;
        }
      }
    },
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin"
    },
    port: 5173,
    strictPort: false
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin"
    }
  }
});
