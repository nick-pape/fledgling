import type { WorkspaceEntry } from "@fledgling/web-agent";
import Editor from "@monaco-editor/react";
import type { FormEvent, ReactElement } from "react";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import type { DemoModelProvider, ModelLoadStatus } from "./model-runner.js";

export type DemoMessage =
  | TextDemoMessage
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: string;
      readonly args?: string;
      readonly result?: string;
      readonly error?: string;
    };

export interface TextDemoMessage {
  readonly role: "user" | "assistant" | "error";
  readonly text: string;
}

export interface RuntimeDetails {
  readonly endpoint: string;
  readonly model: string;
  readonly provider: DemoModelProvider;
  readonly modelStatus: ModelLoadStatus;
  readonly webGpuAvailable: boolean;
  readonly protocolVersion: string | undefined;
  readonly sessionId: string | undefined;
}

export interface WorkspaceBrowserModel {
  readonly entries: readonly WorkspaceEntry[];
  readonly selectedPath: string | undefined;
  readonly preview: string;
  readonly error: string | undefined;
}

export interface DemoViewProps {
  readonly assistantDraft: string;
  readonly browser: WorkspaceBrowserModel;
  readonly messages: readonly DemoMessage[];
  readonly pending: boolean;
  readonly prompt: string;
  readonly runtime: RuntimeDetails;
  readonly status: string;
  readonly onCancel: () => void;
  readonly onModelProviderChange: (provider: DemoModelProvider) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onRefreshFiles: () => void;
  readonly onNewSession: () => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function DemoView(props: DemoViewProps): ReactElement {
  return (
    <main className="app-shell">
      <section className="conversation" aria-label="Conversation">
        <Header
          model={props.runtime.model}
          provider={props.runtime.provider}
          status={props.status}
          webGpuAvailable={props.runtime.webGpuAvailable}
          onModelProviderChange={props.onModelProviderChange}
        />
        <Transcript assistantDraft={props.assistantDraft} messages={props.messages} />
        <Composer
          pending={props.pending}
          prompt={props.prompt}
          ready={props.runtime.sessionId !== undefined && props.runtime.modelStatus.ready}
          onCancel={props.onCancel}
          onPromptChange={props.onPromptChange}
          onSubmit={props.onSubmit}
        />
      </section>
      <aside className="side-panel" aria-label="Workspace">
        <WorkspaceBrowser browser={props.browser} onOpenFile={props.onOpenFile} onRefresh={props.onRefreshFiles} />
        <RuntimePanel runtime={props.runtime} onNewSession={props.onNewSession} />
      </aside>
    </main>
  );
}

export function Header({
  model,
  provider,
  status,
  webGpuAvailable,
  onModelProviderChange
}: {
  readonly model: string;
  readonly provider: DemoModelProvider;
  readonly status: string;
  readonly webGpuAvailable: boolean;
  readonly onModelProviderChange: (provider: DemoModelProvider) => void;
}): ReactElement {
  return (
    <header className="topbar">
      <div>
        <h1>Fledgling</h1>
        <p>{status}</p>
      </div>
      <div className="model-controls">
        <select
          value={provider}
          aria-label="Model provider"
          onChange={(event) => onModelProviderChange(event.target.value as DemoModelProvider)}
        >
          <option value="openai">Remote OpenAI</option>
          <option value="webllm-qwen" disabled={!webGpuAvailable}>
            Local Qwen
          </option>
        </select>
        <div className="model-pill">{model}</div>
      </div>
    </header>
  );
}

export function Transcript({
  assistantDraft,
  messages
}: {
  readonly assistantDraft: string;
  readonly messages: readonly DemoMessage[];
}): ReactElement {
  return (
    <div className="messages">
      {messages.map((message, index) => (
        <MessageView key={`${message.role}-${index}`} message={message} />
      ))}
      {assistantDraft ? <MessageView message={{ role: "assistant", text: assistantDraft }} /> : undefined}
    </div>
  );
}

export function MessageView({ message }: { readonly message: DemoMessage }): ReactElement {
  if (message.role === "tool") {
    return <ToolMessageView message={message} />;
  }

  return (
    <article className={`message message-${message.role}`}>
      <div className="message-label">{message.role}</div>
      <div className="message-body">{message.text}</div>
    </article>
  );
}

export function ToolMessageView({
  message
}: {
  readonly message: Extract<DemoMessage, { readonly role: "tool" }>;
}): ReactElement {
  return (
    <article className={`message message-tool message-tool-${message.status}`}>
      <div className="message-label">
        tool · {message.status}
        <span>{message.toolName}</span>
      </div>
      <div className="message-body">
        {message.args ? (
          <>
            <div className="tool-section-label">args</div>
            <pre>{message.args}</pre>
          </>
        ) : undefined}
        {message.result ? (
          <>
            <div className="tool-section-label">result</div>
            <pre>{message.result}</pre>
          </>
        ) : undefined}
        {message.error ? (
          <>
            <div className="tool-section-label">error</div>
            <pre>{message.error}</pre>
          </>
        ) : undefined}
      </div>
    </article>
  );
}

export function Composer({
  pending,
  prompt,
  ready,
  onCancel,
  onPromptChange,
  onSubmit
}: {
  readonly pending: boolean;
  readonly prompt: string;
  readonly ready: boolean;
  readonly onCancel: () => void;
  readonly onPromptChange: (prompt: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactElement {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        value={prompt}
        rows={3}
        autoComplete="off"
        spellCheck
        onChange={(event) => onPromptChange(event.target.value)}
      />
      <div className="composer-actions">
        <button type="button" onClick={onCancel} disabled={!pending}>
          Cancel
        </button>
        <button type="submit" disabled={pending || !ready}>
          Send
        </button>
      </div>
    </form>
  );
}

export function RuntimePanel({
  runtime,
  onNewSession
}: {
  readonly runtime: RuntimeDetails;
  readonly onNewSession: () => void;
}): ReactElement {
  return (
    <section className="runtime-panel" aria-label="Runtime">
      <dl>
        <RuntimeFact label="Endpoint" value={runtime.endpoint} />
        <RuntimeFact label="Provider" value={runtime.provider === "openai" ? "Remote OpenAI" : "Local Qwen"} />
        <RuntimeFact label="Device" value={formatDevice(runtime)} />
        <RuntimeFact
          label="Model status"
          value={runtime.webGpuAvailable ? formatModelStatus(runtime.modelStatus) : "WebGPU unavailable"}
        />
        <RuntimeFact label="Session" value={runtime.sessionId ?? "pending"} />
        <RuntimeFact label="Protocol" value={runtime.protocolVersion ?? "pending"} />
      </dl>
      <button type="button" onClick={onNewSession}>
        New Session
      </button>
    </section>
  );
}

function formatDevice(runtime: RuntimeDetails): string {
  if (runtime.provider === "openai") {
    return "CPU";
  }

  if (!runtime.webGpuAvailable) {
    return "GPU unavailable";
  }

  return runtime.modelStatus.device ?? (runtime.modelStatus.ready ? "GPU" : "GPU loading");
}

function formatModelStatus(status: ModelLoadStatus): string {
  if (status.error) {
    return status.error;
  }

  if (status.progress !== undefined && !status.ready) {
    return `${Math.round(status.progress * 100)}% ${status.text ?? ""}`.trim();
  }

  return status.text ?? (status.ready ? "Ready" : "Pending");
}

export function RuntimeFact({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface FileTreeNode {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly type: WorkspaceEntry["type"];
  readonly children?: FileTreeNode[];
}

export function WorkspaceBrowser({
  browser,
  onOpenFile,
  onRefresh
}: {
  readonly browser: WorkspaceBrowserModel;
  readonly onOpenFile: (path: string) => void;
  readonly onRefresh: () => void;
}): ReactElement {
  return (
    <section className="workspace-browser">
      <div className="panel-heading">
        <h2>Files</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div className="file-tree">
        <Tree<FileTreeNode>
          data={toTreeData(browser.entries)}
          height={220}
          openByDefault
          rowHeight={28}
          selection={browser.selectedPath}
          width="100%"
          onActivate={(node: NodeApi<FileTreeNode>) => {
            if (node.data.type === "file") {
              onOpenFile(node.data.path);
            } else {
              node.toggle();
            }
          }}
        >
          {FileTreeNodeView}
        </Tree>
      </div>
      <div className="preview-header">{browser.selectedPath ?? "No file selected"}</div>
      <div className="file-preview">
        <Editor
          height="280px"
          language={languageForPath(browser.selectedPath)}
          path={browser.selectedPath}
          theme="vs-light"
          value={browser.preview}
          options={{
            lineNumbersMinChars: 3,
            minimap: { enabled: false },
            readOnly: true,
            scrollBeyondLastLine: false,
            wordWrap: "on"
          }}
        />
      </div>
      {browser.error ? <div className="workspace-error">{browser.error}</div> : undefined}
    </section>
  );
}

function FileTreeNodeView({ node, style }: NodeRendererProps<FileTreeNode>): ReactElement {
  return (
    <button
      type="button"
      className={`file-node file-node-${node.data.type}`}
      style={style}
      onClick={() => {
        if (node.data.type === "file") {
          node.activate();
          return;
        }

        node.toggle();
      }}
    >
      <span>{node.data.type === "directory" ? (node.isOpen ? "v" : ">") : ""}</span>
      {node.data.name}
    </button>
  );
}

function toTreeData(entries: readonly WorkspaceEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeNode>();

  for (const entry of entries) {
    const node: FileTreeNode = {
      id: entry.path,
      name: entry.name,
      path: entry.path,
      type: entry.type,
      children: entry.type === "directory" ? [] : undefined
    };
    if (entry.type === "directory") {
      directories.set(entry.path, node);
    }

    const parentPath = parentDirectory(entry.path);
    const parent = parentPath ? directories.get(parentPath) : undefined;
    if (parent?.children) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function parentDirectory(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index === -1 ? undefined : path.slice(0, index);
}

function languageForPath(path: string | undefined): string {
  const extension = path?.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    default:
      return "plaintext";
  }
}
