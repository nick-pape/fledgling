# Fledgling

A minimal ACP-native TypeScript agent harness.

The v0 target is intentionally small:

- expose an Agent Client Protocol agent over stdio;
- accept prompt turns from an ACP client;
- stream model output through Vercel AI SDK using OpenAI-compatible endpoints;
- ship with no built-in tools.

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
