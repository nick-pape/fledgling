# Fledgling

A minimal ACP-native TypeScript agent harness.

The v0 target is intentionally small but usable:

- expose an Agent Client Protocol agent over stdio;
- accept prompt turns from an ACP client;
- stream model output through Vercel AI SDK using OpenAI-compatible endpoints;
- load MCP tools supplied by the ACP client or local config;
- optionally run a first-party workspace MCP server for local file and command tools;
- persist session events so sessions can be loaded again.

## Development

```sh
rush install
cd packages/acp-agent
heft build --clean
```

## Running

```sh
cd packages/acp-agent
cp .env.example .env
cp fledgling.config.example.json fledgling.config.json
node lib/index.js
```

## Smoke Test

The package includes a small ACP client harness for local development:

```sh
cd packages/acp-agent
pnpm smoke "Write a short four-line poem about an ACP agent."
```

Optional environment variables:

- `OPENAI_BASE_URL`: OpenAI-compatible base URL.
- `OPENAI_MODEL`: model name, default `gpt-4.1-mini`.
- `FLEDGLING_SYSTEM_PROMPT`: override the default system prompt.
- `FLEDGLING_CONFIG`: path to a launch config, default `./fledgling.config.json`.
- `FLEDGLING_OPENAI_API`: `chat` or `responses`, default `chat` for OpenAI-compatible local backends.
- `FLEDGLING_TOOL_CHOICE`: optional debug override to force one tool, for example `workspace_list_directory`.

Launch config supports MCP servers:

```json
{
  "mcpServers": {
    "workspace": {
      "type": "firstPartyWorkspace"
    }
  }
}
```

The `firstPartyWorkspace` server exposes MCP tools for:

- reading files;
- listing directories;
- searching text;
- writing files;
- replacing a range in a file with hash checking;
- running non-interactive workspace commands.

Workspace tools return Fledgling context hints in their structured MCP output. The agent currently records those hints in the session log; richer context replay and compaction are still in progress.

## Sessions

Sessions are written as JSONL event logs under `.fledgling/sessions` by default. Set `FLEDGLING_SESSION_DIR` to change the directory or `FLEDGLING_SESSION_FILE` to force a single log file for development.

The agent advertises ACP `loadSession` support. Loading a session rebuilds the user/assistant message history from stored events and replays that transcript to the ACP client.

## Current Limitations

- Prompt input is treated mostly as text; rich ACP prompt parts are not yet preserved semantically.
- Workspace access is provided through MCP tools, not ACP host filesystem or terminal APIs.
- ACP authentication, session modes, model selection, and permission prompts are still minimal or stubbed.
- Tool result context hints are recorded but not yet used for full context-store replay.
