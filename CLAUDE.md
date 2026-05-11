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

### MCP server (`mcp-server/src/index.ts` + `mcp-server/src/session.ts`)

Two tools: `Task` (spawns a nested agent) and `AbortTask` (cancels a running one). `runTask` in `index.ts` orchestrates the spawn; the pure helpers it relies on live in `session.ts` so they can be unit-tested without booting the stdio server.

The spawn command produced by `buildClaudeArgs`:

```
claude -p <prompt> --output-format stream-json --verbose --model <model> \
  [--dangerously-skip-permissions | --permission-mode <mode>] \
  [--system-prompt …] [--append-system-prompt …] \
  [--allowed-tools …] [--disallowed-tools …] \
  [--max-budget-usd …] [--add-dir …] \
  [--resume <id> | --continue] [--session-id <id>] [--fork-session] \
  [--no-session-persistence] \
  [--plugin-dir $CLAUDE_PLUGIN_ROOT]   # only when env var is set
```

Then it line-parses stdout (newline-delimited JSON) and emits MCP `notifications/progress` for each `system`/`assistant`/`user`/`result` event, capturing tool-use counts, token usage, cost, and `session_id` from the events.

**Things to know when editing this file:**

- `proc.stdin?.end()` runs immediately after spawn — `claude -p` takes the prompt as a CLI arg, not via stdin, and the process hangs if stdin stays open.
- The `--plugin-dir` propagation depends on `CLAUDE_PLUGIN_ROOT` being set in the env. Without it, the spawned process won't have this plugin's MCP server, and nesting beyond one level silently stops working. **Resumed sessions still need `--plugin-dir`** — the propagation runs through the same code path.
- `--no-session-persistence` is conditional. It's appended only when `persistSession` is unset/false AND none of `resume`/`continueRecent`/`sessionId`/`forkSession` are set. Setting `persistSession: false` together with any resume param is a hard error (CLI would reject it too).
- Session lifecycle validation lives in `validateSessionParams` (`session.ts`). Rules: `resume`/`continueRecent` are mutually exclusive; `forkSession` requires one of them; `sessionId` + `resume`/`continueRecent` requires `forkSession` (CLI requirement).
- `activeProcesses` is `Map<string, ActiveTaskEntry>`. Entries are registered with `proc: null` **before** `spawn()` returns so an `AbortTask` call that races the spawn can queue a signal; the spawn path delivers the queued signal once it attaches the real `ChildProcess`.
- Timeout: `SIGTERM`, then `SIGKILL` 5s later. All active entries are torn down on `SIGTERM`/`SIGINT` to the server itself.
- Debug log: `/tmp/fallback-agent-debug.log` (overwritten on each server start).
- Persistent sessions accumulate under `~/.claude/sessions/`. The plugin does not clean them up.

## Tool parameters

### `mcp__plugin_fallback-agent_fallback__Task`

Schema lives in `mcp-server/src/index.ts` (`NESTED_TASK_TOOL.inputSchema`); the shared `TaskInput` type and helpers are in `mcp-server/src/session.ts`.

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
| `sessionId`          | string   | `--session-id <uuid>` — names a new session, or the forked session ID when combined with `resume`/`continueRecent` (requires `forkSession`). |
| `resume`             | string   | `--resume <uuid>` — resume an existing session. Implies `persistSession: true`; mutually exclusive with `continueRecent`. |
| `continueRecent`     | boolean  | `--continue` — resume the most recent session in `workingDir`. Implies `persistSession: true`; mutually exclusive with `resume`. |
| `forkSession`        | boolean  | `--fork-session` — when resuming, create a new session ID. Requires `resume` or `continueRecent`. |
| `persistSession`     | boolean  | Default `false` (appends `--no-session-persistence`). Any of `resume`/`continueRecent`/`sessionId`/`forkSession` implies `true`; explicit `false` alongside them is rejected. |
| `taskId`             | string   | Caller-supplied handle for `AbortTask`. Auto-generated if omitted and emitted in the first progress notification (`taskId=…`). |

The result text ends with a metadata trailer the caller can parse:

```
Done (N tool uses · Xk tokens · Ys)
task_id: <id>
session_id: <uuid>
persisted: true|false
```

### `mcp__plugin_fallback-agent_fallback__AbortTask`

| Parameter | Type   | Notes                                                                                          |
|-----------|--------|------------------------------------------------------------------------------------------------|
| `taskId`  | string | Required. The handle from `Task.taskId` (caller-supplied or auto-generated, in progress msg). |
| `signal`  | enum   | `SIGTERM` (default) \| `SIGINT` \| `SIGKILL`.                                                 |

Returns one of: `aborted` (signal delivered), `pending` (queued — proc not yet attached), `not_found` (no such taskId), `already_exited`.
