import { describe, expect, it } from "vitest";

import { convertPromptContent, messageContentToText, renderPromptContent } from "./prompt-content.js";

describe("prompt content conversion", () => {
  it("preserves text and resource links with deterministic fallback text", () => {
    const converted = convertPromptContent({
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "Review this." },
        {
          type: "resource_link",
          uri: "file:///repo/README.md",
          name: "README.md",
          title: "Project README",
          description: "Repository overview",
          mimeType: "text/markdown",
          size: 42
        }
      ]
    });

    expect(converted.content).toEqual([
      { type: "text", text: "Review this." },
      {
        type: "resource_link",
        uri: "file:///repo/README.md",
        name: "README.md",
        title: "Project README",
        description: "Repository overview",
        mimeType: "text/markdown",
        size: 42
      }
    ]);
    expect(converted.text).toBe(
      "Review this.\n[Resource link: Project README <file:///repo/README.md> (text/markdown, 42 bytes)] - Repository overview"
    );
    expect(converted.modelContent).toEqual([
      { type: "text", text: "Review this." },
      {
        type: "text",
        text: "[Resource link: Project README <file:///repo/README.md> (text/markdown, 42 bytes)] - Repository overview"
      }
    ]);
  });

  it("forwards image parts to the model when image input is enabled", () => {
    const converted = convertPromptContent(
      {
        sessionId: "session-1",
        prompt: [
          { type: "text", text: "Describe this." },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png", uri: "file:///repo/image.png" }
        ]
      },
      { imageInput: true }
    );

    expect(converted.content).toEqual([
      { type: "text", text: "Describe this." },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png", uri: "file:///repo/image.png" }
    ]);
    expect(converted.text).toBe("Describe this.\n[Image: image/png, uri: file:///repo/image.png, base64 chars: 8]");
    expect(converted.modelContent).toEqual([
      { type: "text", text: "Describe this." },
      { type: "image", image: "aW1hZ2U=", mediaType: "image/png" }
    ]);
  });

  it("renders image parts as text when image input is disabled", () => {
    const converted = convertPromptContent({
      sessionId: "session-1",
      prompt: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]
    });

    expect(converted.text).toBe("[Image: image/png, base64 chars: 8]");
    expect(converted.modelContent).toBe("[Image: image/png, base64 chars: 8]");
  });

  it("preserves unsupported blocks and renders them as fallback text", () => {
    const raw = { type: "audio", data: "abc", mimeType: "audio/wav" } as const;
    const converted = convertPromptContent({
      sessionId: "session-1",
      prompt: [raw]
    });

    expect(converted.content).toEqual([{ type: "unsupported", originalType: "audio", raw }]);
    expect(renderPromptContent(converted.content)).toBe(
      '[Unsupported ACP content block: audio] {"type":"audio","data":"abc","mimeType":"audio/wav"}'
    );
  });

  it("renders model image and file parts without serializing payloads", () => {
    expect(
      messageContentToText([
        { type: "text", text: "Loaded image" },
        { type: "image", image: "aW1hZ2U=", mediaType: "image/png" },
        { type: "file", data: "ZmlsZQ==", mediaType: "application/pdf", filename: "report.pdf" }
      ])
    ).toBe("Loaded image\n[Image: image/png, base64 chars: 8]\n[File: application/pdf, filename: report.pdf, base64 chars: 8]");
  });
});
