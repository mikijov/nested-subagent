# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Claude Code plugin that enables **unlimited nested subagents**. The native Task tool's `AgentTool` filters itself out of subagent tool lists (`src/tools/AgentTool/prompt.ts` in the Claude Code source), so subagents cannot spawn further subagents. This plugin sidesteps that by exposing an MCP `Task` tool that spawns a fresh `claude -p` subprocess — a brand-new main agent with full tool access, including the native Task tool.

### Naming

The repo, plugin, and MCP server all use slightly different names — keep them straight:

- Repo directory: `nested-subagent`
- Plugin name (`.claude-plugin/marketplace.json`): `fallback-agent`
- MCP server name (`.mcp.json`): `fallback`
- Exposed tool: `mcp__plugin_fallback-agent_fallback__Task`

## Commands

All commands run from `mcp-server/`. The project uses `npm` (canonical lockfile: `package-lock.json`); every script just shells out to a `devDependency` (`tsdown`, `tsc`, `tsx`, `vitest`).

### Required tooling

- `claude` CLI on `PATH` — the MCP server spawns `claude -p` for each nested task. Without it the tool returns `Failed to spawn`.
- Node.js `>= 18` — runtime for the bundled `dist/index.mjs`.
- `npm` — package manager + script runner. `npm install` populates `node_modules` with `tsdown`, `tsc`, `tsx`, `vitest`.

### Build & dev

```bash
npm run build      # Bundle via tsdown → dist/index.mjs (single ESM file, all deps inlined)
npm run dev        # Run server directly with tsx
npm run typecheck  # tsc --noEmit
```

### Tests

```bash
npm test                                # Unit tests (free, no Claude spawns)
npm run test:watch                      # Unit watch mode
npm run test:integration                # Integration tests — spawns real `claude` processes; costs $$
npm test -- test/helpers.test.ts        # Single file
npm test -- --grep "extractText"        # Pattern match
```

Integration tests pin to `model: "haiku"` with low `maxTurns` to bound cost; they run serially in a single fork (see `vitest.integration.config.ts`).

### Plugin install (for manual testing)

```bash
claude --plugin-dir /path/to/nested-subagent   # Per-session
claude /plugin install ./nested-subagent       # Local install
# Or add marketplace `gruckion/nested-subagent` via the /plugin UI
```

The marketplace entry points at `mcp-server/dist/index.mjs`, so `npm run build` is required before installs pick up code changes.

## Architecture

### The bypass

```
Native:  Main → Task → Subagent (Task filtered out) → BLOCKED
Plugin:  Main → mcp Task → spawn `claude -p` → Fresh Main Agent → CAN Task → unlimited depth
```

The recursion blocker in native Claude Code (`.filter(_ => _.name !== AgentTool.name)`) is process-local. A fresh `claude -p` process is a new main agent that the blocker never touches.

### MCP server (`mcp-server/src/index.ts`)

Single tool, named `Task` to mirror the native UX. The handler (`runTask`, ~line 240) builds CLI args and spawns:

```
claude -p <prompt> --output-format stream-json --verbose --model <model> \
  [--dangerously-skip-permissions | --permission-mode <mode>] \
  [--system-prompt …] [--append-system-prompt …] \
  [--allowed-tools …] [--disallowed-tools …] \
  [--max-budget-usd …] [--add-dir …] \
  --no-session-persistence \
  [--plugin-dir $CLAUDE_PLUGIN_ROOT]   # only when env var is set
```

Then it line-parses stdout (newline-delimited JSON) and emits MCP `notifications/progress` for each `system`/`assistant`/`user`/`result` event, capturing tool-use counts, token usage, and cost from the final `result` message.

**Things to know when editing this file:**

- `proc.stdin?.end()` runs immediately after spawn — `claude -p` takes the prompt as a CLI arg, not via stdin, and the process hangs if stdin stays open.
- The `--plugin-dir` propagation depends on `CLAUDE_PLUGIN_ROOT` being set in the env. Without it, the spawned process won't have this plugin's MCP server, and nesting beyond one level silently stops working.
- `--no-session-persistence` is always passed so spawned tasks don't pollute session history.
- Timeout: `SIGTERM`, then `SIGKILL` 5s later. All active PIDs are tracked in `activeProcesses` and torn down on `SIGTERM`/`SIGINT` to the server itself.
- Debug log: `/tmp/fallback-agent-debug.log` (overwritten on each server start).

## Tool parameters

`mcp__plugin_fallback-agent_fallback__Task` — schema lives in `mcp-server/src/index.ts` (`NESTED_TASK_TOOL.inputSchema`).

| Parameter            | Type     | Notes                                                                |
|----------------------|----------|----------------------------------------------------------------------|
| `prompt`             | string   | Required.                                                            |
| `description`        | string   | 3–5 word UI summary.                                                 |
| `model`              | enum     | `sonnet` (default) \| `opus` \| `haiku`.                             |
| `workingDir`         | string   | Defaults to `process.cwd()`.                                         |
| `timeout`            | number   | Milliseconds. Default `600000` (10 min).                             |
| `allowWrite`         | boolean  | Adds `--dangerously-skip-permissions` (mutually exclusive w/ below). |
| `permissionMode`     | enum     | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan`. |
| `systemPrompt`       | string   | `--system-prompt`.                                                   |
| `appendSystemPrompt` | string   | `--append-system-prompt`.                                            |
| `allowedTools`       | string[] | `--allowed-tools`.                                                   |
| `disallowedTools`    | string[] | `--disallowed-tools`.                                                |
| `maxBudgetUsd`       | number   | `--max-budget-usd`.                                                  |
| `addDirs`            | string[] | `--add-dir`.                                                         |
