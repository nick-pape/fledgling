# @fledgling/acp-host-log

A small logging ACP host for exercising Fledgling through the real ACP client side.

Run a human-readable transcript:

```powershell
$env:FLEDGLING_AGENT_CWD = "C:\Users\nickp\src\fledgling\packages\acp-agent"
node packages/acp-host-log/lib/index.js "Reply with exactly: host snapshot ok"
```

Run a JSONL transcript:

```powershell
$env:FLEDGLING_AGENT_CWD = "C:\Users\nickp\src\fledgling\packages\acp-agent"
node packages/acp-host-log/lib/index.js --json "Reply with exactly: host snapshot ok"
```

Run a deterministic JSONL transcript for snapshots:

```powershell
$env:FLEDGLING_AGENT_CWD = "C:\Users\nickp\src\fledgling\packages\acp-agent"
node packages/acp-host-log/lib/index.js --json --deterministic "Reply with exactly: host snapshot ok"
```

Inject ACP-owned MCP servers with either `FLEDGLING_HOST_MCP_SERVERS` or
`FLEDGLING_HOST_MCP_SERVERS_FILE`:

```powershell
$env:FLEDGLING_HOST_MCP_SERVERS_FILE = "packages/acp-host-log/mcp-servers.example.json"
node packages/acp-host-log/lib/index.js --deterministic "Use the injected MCP server."
```

For the repo's first-party workspace MCP, use the convenience flag:

```powershell
node packages/acp-host-log/lib/index.js --workspace-mcp "List the workspace root."
```

Useful environment variables:

- `FLEDGLING_ENV_FILE`: explicit `.env` file to load before spawning the agent.
- `FLEDGLING_HOST_CWD`: ACP session `cwd`; defaults to the current directory.
- `FLEDGLING_AGENT_CWD`: working directory for the spawned ACP agent process.
- `FLEDGLING_AGENT_COMMAND`: agent command; defaults to `node`.
- `FLEDGLING_AGENT_ARGS_JSON`: JSON array of agent args; defaults to this repo's Fledgling agent.
- `FLEDGLING_HOST_JSON=1`: emit JSONL events.
- `FLEDGLING_HOST_DETERMINISTIC=1`: same as `--deterministic`.
- `FLEDGLING_HOST_WORKSPACE_MCP=1`: inject the first-party workspace MCP.

If `FLEDGLING_ENV_FILE` is not set, the host loads the first `.env` it finds from:
the current directory, `FLEDGLING_AGENT_CWD`, then the installed `@fledgling/acp-agent`
package root.
