# Fledgling Research Notes

Fledgling is an ACP-native agent runtime. The current v0 proves the smallest useful loop:

- speak ACP over stdio;
- accept sessions and prompt turns;
- stream model output back to the ACP client;
- call OpenAI-compatible model endpoints through Vercel AI SDK;
- ship with no built-in tools.

The interesting work starts after that. This document outlines the problems we need to solve and the pieces we likely need to build.

## Core Thesis

The base agent harness should not own tools. It should own the loop, session state, prompt assembly, and model/provider behavior.

Tools should come from MCP servers, including first-party MCP servers for workspace, shell, browser, memory, retrieval, and other capabilities. This keeps the runtime pluggable and lets the same agent operate in environments with no filesystem, no shell, remote resources, or specialized tool surfaces.

The hard part is that normal tool responses are not enough for an agent optimized around local LLMs. A local-LLM-friendly harness needs to know how tool results should become context.

## Problem: Tool Output Is Not Context Strategy

The naive loop is:

1. Model asks for a tool.
2. Agent runs the tool.
3. Agent appends the tool result to the conversation.
4. Model continues.

That works, but it is a poor fit for small contexts, local inference, prefix caching, and long-running sessions. Tool output can be huge, noisy, stale, redundant, or ordered in a way that destroys cache reuse.

What we actually need is a distinction between:

- **tool execution**: the external action performed by an MCP server;
- **context materialization**: how the result is represented, retained, ordered, summarized, and injected into a model prompt.

The harness should not implement `readFile`, `grep`, `bash`, or `browser.open`. But it probably should implement the policy for turning returned file contents, search hits, command output, and diagnostics into prompt material.

## First-Party MCP Metadata Extension

Standard MCP tool descriptions are not enough for aggressive context assembly. We likely need a first-party convention, embedded in MCP metadata or result annotations, that describes context semantics.

Example shape:

```ts
type ContextHint = {
  kind:
    | "ephemeral_observation"
    | "durable_resource"
    | "workspace_map"
    | "diagnostic"
    | "command_output"
    | "user_memory";

  identity?: string;
  contentHash?: string;
  tokenEstimate?: number;

  placement:
    | "stable_prefix"
    | "session_context"
    | "turn_context"
    | "latest_evidence"
    | "do_not_inline";

  retention:
    | "discard_after_turn"
    | "summarize_after_turn"
    | "retain_until_changed"
    | "retain_for_session";

  priority?: number;
  routingTags?: string[];
};
```

Tool results could then carry structured context objects:

```ts
{
  content: "...",
  context: {
    kind: "durable_resource",
    identity: "file:///repo/src/index.ts",
    contentHash: "sha256:...",
    tokenEstimate: 1240,
    placement: "latest_evidence",
    retention: "retain_until_changed",
    routingTags: ["typescript", "source"]
  }
}
```

This lets the harness make prompt assembly decisions without owning the tool implementation.

## Local LLM Constraints

Hosted frontier models tolerate a lot of waste. Local models often do not.

The harness should be designed around:

- limited context windows;
- lower instruction-following reliability;
- weaker tool-use reliability;
- slower prefill;
- prefix-cache sensitivity;
- slot/session affinity;
- quantization-specific behavior;
- provider-specific options such as context size, keep-alive, reasoning mode, and cache controls.

This implies that prompt assembly needs to be deterministic and cache-aware.

Suggested prompt layout:

1. **Stable prefix**
   - agent identity;
   - durable behavioral contract;
   - output/update protocol rules;
   - stable tool contracts or selected tool subset.

2. **Session context**
   - durable conversation summary;
   - stable workspace/resource map;
   - retained memories or user preferences.

3. **Turn context**
   - current objective;
   - recent transcript tail;
   - selected context objects.

4. **Latest evidence**
   - fresh tool results;
   - file excerpts;
   - command output;
   - diagnostics.

5. **User request**
   - latest prompt and explicit instructions.

The stable prefix should change as rarely as possible. Volatile material should appear late. Context objects should be ordered deterministically by placement, priority, identity, and content hash.

## Slot Routing

For local inference servers with slots or session-like cache behavior, the harness should eventually support routing turns to slots.

Questions to answer:

- How many model slots should a user configure?
- Should slots map one-to-one with ACP sessions?
- When should a slot be reused, reset, saved, or restored?
- How do we keep prompt prefixes stable enough to benefit from cache reuse?
- Can context object identity and hashes help avoid unnecessary reinjection?

This probably belongs behind provider profiles, not in the generic ACP loop.

## Tool Selection

Even with MCP, the model should not always see every tool.

We need a tool registry that can:

- ingest MCP tool schemas;
- preserve raw MCP metadata;
- apply first-party context metadata conventions;
- select a small active tool subset per turn;
- expose deterministic tool ordering;
- enforce capability and permission constraints;
- eventually support model-specific tool rendering.

The base harness remains tool-free. It still owns tool selection policy.

## Context Store

The harness likely needs a session-local context store.

Responsibilities:

- hold context objects returned by MCP tools;
- dedupe by identity and content hash;
- estimate token cost;
- track freshness and retention policy;
- summarize or discard after turn completion;
- expose context candidates to the prompt compiler.

This is separate from conversation history. Conversation history is what happened. Context store is what may be useful to materialize.

## Provider Profiles

AI SDK gives us a common provider interface, but local endpoints need profile-specific behavior.

Profiles we likely care about:

- OpenAI-compatible hosted endpoints;
- OpenAI-compatible local endpoints;
- Ollama;
- llama.cpp server;
- vLLM;
- LM Studio;
- OpenRouter or similar routers.

Profile responsibilities:

- default model options;
- unsupported-feature handling;
- tool-call strategy;
- streaming quirks;
- context window assumptions;
- slot/cache behavior;
- retry and error normalization.

## ACP Integration

ACP should remain the outer interface.

Need to build:

- proper cancellation with abort signals;
- session mode handling if needed;
- auth handling if needed;
- client capability detection;
- permission request plumbing for MCP tools;
- richer session updates for plans, tool calls, and diagnostics;
- Grackle runtime configuration.

The agent should only use ACP client filesystem or terminal capabilities when the client advertises them. Otherwise, equivalent capabilities must come from MCP servers.

## Testing

We need tests that do not require a live model endpoint.

Likely layers:

- ACP protocol smoke tests using a fake model provider;
- prompt compiler snapshot tests;
- context store unit tests;
- MCP metadata parsing tests;
- provider profile tests with mocked HTTP;
- optional live smoke tests gated by environment variables.

The existing `pnpm smoke` harness is useful, but it is not a replacement for deterministic tests.

## Near-Term Build Plan

1. Extract the model loop behind a small internal interface.
2. Add cancellation support.
3. Add fake model tests for ACP prompt turns.
4. Add a prompt compiler with stable sections, even before MCP exists.
5. Add a context object model and context store.
6. Add MCP client support with no first-party extensions.
7. Add first-party MCP metadata conventions.
8. Build first-party workspace MCP as the first serious tool provider.
9. Add local provider profiles and slot/cache experiments.

## Open Questions

- Should first-party MCP metadata live in tool annotations, result annotations, resource metadata, or all three?
- How much of the metadata convention should be documented as public API?
- Should the context store be session-only at first, or persistent?
- Do we need a separate "context planning" model step, or can this be deterministic initially?
- How should Grackle expose model/provider/profile configuration?
- How do we keep generic MCP tools useful without first-party metadata?

