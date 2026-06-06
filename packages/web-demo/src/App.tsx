import type * as acp from "@agentclientprotocol/sdk";
import type { IWorkspaceRuntime, WorkspaceEntry } from "@fledgling/web-agent";
import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { createDemoSession, createDemoWorkspace, type DemoSession } from "./acp-demo.js";
import { DemoView, type DemoMessage, type WorkspaceBrowserModel } from "./components.js";
import {
  createModelTurnRunner,
  type BrowserModelTurnRunner,
  type DemoModelProvider,
  type ModelLoadStatus
} from "./model-runner.js";

export function App(): ReactElement {
  const webGpuAvailable = useMemo(() => "gpu" in navigator, []);
  const [provider, setProvider] = useState<DemoModelProvider>("openai");
  const [modelStatus, setModelStatus] = useState<ModelLoadStatus>({
    provider: "openai",
    ready: true,
    text: "Remote endpoint",
    device: "CPU"
  });
  const modelRunner = useMemo(
    () =>
      createModelTurnRunner({
        provider,
        envSource: import.meta.env,
        onStatusChange: setModelStatus
      }),
    [provider]
  );
  const modelRunnerRef = useRef<BrowserModelTurnRunner>(modelRunner);
  const workspaceRuntimeRef = useRef<IWorkspaceRuntime | undefined>(undefined);
  const selectedPathRef = useRef<string | undefined>(undefined);
  const [workspaceRuntime, setWorkspaceRuntime] = useState<IWorkspaceRuntime | undefined>();
  const [session, setSession] = useState<DemoSession | undefined>();
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("Starting");
  const [pending, setPending] = useState(false);
  const [browser, setBrowser] = useState<WorkspaceBrowserModel>({
    entries: [],
    selectedPath: undefined,
    preview: "",
    error: undefined
  });

  useEffect(() => {
    selectedPathRef.current = browser.selectedPath;
  }, [browser.selectedPath]);

  useEffect(() => {
    modelRunnerRef.current = modelRunner;
    setModelStatus(modelRunner.status);
    if (workspaceRuntimeRef.current) {
      void startSession(workspaceRuntimeRef.current);
    }

    if (modelRunner.warmup) {
      void modelRunner.warmup().catch((error) => {
        setMessages((current) => [...current, { role: "error", text: errorText(error) }]);
      });
    }

    return () => {
      void modelRunner.dispose?.();
    };
  }, [modelRunner]);

  useEffect(() => {
    let disposed = false;
    async function boot(): Promise<void> {
      try {
        setStatus("Starting workspace");
        const runtime = await createDemoWorkspace();
        if (disposed) {
          return;
        }

        setWorkspaceRuntime(runtime);
        workspaceRuntimeRef.current = runtime;
        await refreshFileBrowser(runtime);
        await startSession(runtime);
      } catch (error) {
        setMessages((current) => [...current, { role: "error", text: errorText(error) }]);
        setStatus("Startup error");
      }
    }

    void boot();
    return () => {
      disposed = true;
    };
  }, []);

  async function startSession(runtime: IWorkspaceRuntime): Promise<void> {
    setStatus("Starting");
    setSession(await createDemoSession(modelRunnerRef.current, runtime, handleSessionUpdate));
    setStatus("Ready");
  }

  function handleSessionUpdate(params: acp.SessionNotification): void {
    const { update } = params;

    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentBlockText(update.content);
      if (text !== undefined) {
        setAssistantDraft((current) => current + text);
      }
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      setMessages((current) => [
        ...current,
        {
          role: "tool",
          toolCallId: update.toolCallId,
          toolName: update.title,
          status: update.status ?? "pending",
          args: formatJson(update.rawInput)
        }
      ]);
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      setMessages((current) => updateToolMessage(current, update));
      if (update.status === "completed" && workspaceRuntimeRef.current) {
        void refreshFileBrowser(workspaceRuntimeRef.current, selectedPathRef.current);
      }
    }
  }

  async function sendPrompt(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || pending || !session || !modelRunner.ready) {
      return;
    }

    setMessages((current) => [...current, { role: "user", text }]);
    setAssistantDraft("");
    setPrompt("");
    setPending(true);
    setStatus("Running");

    try {
      const response = await session.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text }]
      });
      setAssistantDraft((draft) => {
        if (draft) {
          setMessages((current) => [...current, { role: "assistant", text: draft }]);
        }

        return "";
      });
      setStatus(response.stopReason);
    } catch (error) {
      setMessages((current) => [...current, { role: "error", text: errorText(error) }]);
      setStatus("Error");
    } finally {
      setPending(false);
    }
  }

  async function cancelPrompt(): Promise<void> {
    if (session && pending) {
      await session.connection.cancel({ sessionId: session.sessionId });
    }
  }

  async function newSession(): Promise<void> {
    if (!workspaceRuntime) {
      return;
    }

    if (session) {
      await session.connection.cancel({ sessionId: session.sessionId });
    }

    setMessages([]);
    setAssistantDraft("");
    await startSession(workspaceRuntime);
  }

  async function changeProvider(nextProvider: DemoModelProvider): Promise<void> {
    if (nextProvider === provider) {
      return;
    }

    if (session) {
      await session.connection.cancel({ sessionId: session.sessionId });
    }

    setMessages([]);
    setAssistantDraft("");
    setPending(false);
    setProvider(nextProvider);
  }

  async function refreshFileBrowser(
    runtime = workspaceRuntimeRef.current ?? workspaceRuntime,
    selectedPath = selectedPathRef.current
  ): Promise<void> {
    if (!runtime) {
      return;
    }

    try {
      const entries = await collectWorkspaceEntries(runtime, ".");
      let preview = "";
      let nextSelectedPath = selectedPath;
      if (nextSelectedPath) {
        preview = await runtime.readFile(nextSelectedPath);
      } else {
        const firstFile = entries.find((entry) => entry.type === "file");
        nextSelectedPath = firstFile?.path;
        preview = firstFile ? await runtime.readFile(firstFile.path) : "";
      }

      setBrowser({
        entries,
        selectedPath: nextSelectedPath,
        preview,
        error: undefined
      });
      selectedPathRef.current = nextSelectedPath;
    } catch (error) {
      setBrowser((current) => ({ ...current, error: errorText(error) }));
    }
  }

  async function openWorkspaceFile(path: string): Promise<void> {
    if (!workspaceRuntime) {
      return;
    }

    try {
      setBrowser((current) => ({
        ...current,
        selectedPath: path,
        preview: "",
        error: undefined
      }));
      const preview = await workspaceRuntime.readFile(path);
      setBrowser((current) => ({
        ...current,
        selectedPath: path,
        preview,
        error: undefined
      }));
      selectedPathRef.current = path;
    } catch (error) {
      setBrowser((current) => ({
        ...current,
        selectedPath: path,
        error: errorText(error)
      }));
    }
  }

  return (
    <DemoView
      assistantDraft={assistantDraft}
      browser={browser}
      messages={messages}
      pending={pending}
      prompt={prompt}
      runtime={{
        endpoint: modelRunner.endpoint,
        model: modelRunner.model,
        provider,
        modelStatus,
        webGpuAvailable,
        protocolVersion: session?.protocolVersion,
        sessionId: session?.sessionId
      }}
      status={status}
      onCancel={() => void cancelPrompt()}
      onModelProviderChange={(nextProvider) => void changeProvider(nextProvider)}
      onOpenFile={(path) => void openWorkspaceFile(path)}
      onRefreshFiles={() => void refreshFileBrowser()}
      onNewSession={() => void newSession()}
      onPromptChange={setPrompt}
      onSubmit={(event) => void sendPrompt(event)}
    />
  );
}

async function collectWorkspaceEntries(
  runtime: IWorkspaceRuntime,
  path: string
): Promise<WorkspaceBrowserModel["entries"]> {
  const entries = await runtime.listDirectory(path);
  const result: WorkspaceEntry[] = [];

  for (const entry of entries.sort((left, right) => compareEntries(left, right))) {
    result.push(entry);
    if (entry.type === "directory") {
      result.push(...(await collectWorkspaceEntries(runtime, entry.path)));
    }
  }

  return result;
}

function compareEntries(
  left: WorkspaceBrowserModel["entries"][number],
  right: WorkspaceBrowserModel["entries"][number]
): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function updateToolMessage(
  messages: readonly DemoMessage[],
  update: ToolCallUpdate
): DemoMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.role === "tool" && message.toolCallId === update.toolCallId);
  const text = extractToolUpdateText(update);
  if (index === -1) {
    next.push({
      role: "tool",
      toolCallId: update.toolCallId,
      toolName: update.toolCallId,
      status: update.status ?? "pending",
      result: text,
      error: update.status === "failed" ? text : undefined
    });
    return next;
  }

  const current = next[index];
  if (current.role !== "tool") {
    return next;
  }

  next[index] = {
    ...current,
    status: update.status ?? "pending",
    result: update.status === "failed" ? current.result : text,
    error: update.status === "failed" ? text : current.error
  };
  return next;
}

function extractToolUpdateText(update: ToolCallUpdate): string | undefined {
  const parts = update.content ?? [];
  const text = parts
    .map((part) => (part.type === "content" && part.content.type === "text" ? part.content.text : undefined))
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function formatJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = safeStringify(value);
  return text === undefined ? undefined : text;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return safeStringify(error) ?? String(error);
}

function safeStringify(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, undefined, 2);
  } catch {
    return undefined;
  }
}

function contentBlockText(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) {
    return undefined;
  }

  const maybeText = content as { readonly type?: unknown; readonly text?: unknown };
  return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : undefined;
}

type ToolCallUpdate = Extract<acp.SessionNotification["update"], { readonly sessionUpdate: "tool_call_update" }>;
