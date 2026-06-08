import { defineConfig } from "vite";
import nodepod from "@scelar/nodepod/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [nodepod()],
  resolve: {
    alias: {
      "node:module": fileURLToPath(new URL("./src/node-module-shim.ts", import.meta.url)),
      "node:process": fileURLToPath(new URL("./src/node-process-shim.ts", import.meta.url))
    }
  },
  build: {
    chunkSizeWarningLimit: 8000,
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
            normalized.includes("@mlc-ai/web-llm") ||
            normalized.includes("@mlc-ai/web-runtime") ||
            normalized.includes("@mlc-ai/web-tokenizers") ||
            normalized.includes("@mlc-ai/web-xgrammar")
          ) {
            return "webllm-runtime";
          }

          if (normalized.includes("@scelar/nodepod")) {
            return "nodepod-runtime";
          }

          if (
            normalized.includes("@agentclientprotocol/sdk") ||
            normalized.includes("@ai-sdk/mcp") ||
            normalized.includes("@fledgling/") ||
            normalized.includes("@modelcontextprotocol/sdk") ||
            normalized.includes("/ajv") ||
            normalized.includes("/ajv-formats") ||
            normalized.includes("/fast-uri") ||
            normalized.includes("/zod")
          ) {
            return "webagent-runtime";
          }

          if (normalized.includes("@webcontainer/api")) {
            return "webcontainer-runtime";
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
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin"
    },
    port: 5173,
    strictPort: false
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin"
    }
  }
});
