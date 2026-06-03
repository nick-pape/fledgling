import { describe, expect, it } from "vitest";

import { createPromptRpcError, normalizePromptError } from "./prompt-errors.js";

describe("prompt error helpers", () => {
  it("sanitizes model errors before durable reporting", () => {
    const error = new Error("\u001B[31mfailed\nBearer abc.def.ghi sk-testsecret123");
    const normalized = normalizePromptError(error, "model_start_failed", "model_start");

    expect(normalized).toMatchObject({
      kind: "model_start_failed",
      phase: "model_start",
      message: "failed Bearer [redacted] sk-[redacted]",
      recoverable: true,
      errorName: "Error"
    });
  });

  it("creates sanitized RPC errors", () => {
    expect(createPromptRpcError(new Error("token=secret-value"), "model_stream").message).toBe(
      "Fledgling model stream failed: token=[redacted]"
    );
  });
});
