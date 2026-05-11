# Nested Subagent

![Nested Subagent banner](assets/banner.jpg)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-v1.0.33+-blue.svg)](https://docs.anthropic.com/en/docs/claude-code)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/gruckion/nested-subagent/pulls)

Enable **unlimited nested subagents** in Claude Code. Subagents can spawn their own subagents.

---

## Prerequisites

| Tool | Version | Why it's needed |
|------|---------|-----------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) (`claude` on `PATH`) | `>= 1.0.33` | The plugin's MCP server spawns `claude -p` for each nested session. |
| [Node.js](https://nodejs.org/) | `>= 18` | Runs the built `dist/index.mjs` once the plugin is installed. |
| [npm](https://www.npmjs.com/) | latest | Installs deps and runs the build/test scripts. |
| [git](https://git-scm.com/) | any | Required for the local-install path below. |

Marketplace installs only need `claude` and `node` — the bundled `dist/index.mjs` is shipped pre-built. The other tools are only required when building from source.

---

## Quick Start

### Option 1: Install from Marketplace (Recommended)

1. Run `/plugin` in Claude Code
2. Go to **Marketplaces** tab
3. Select **+ Add Marketplace**
4. Enter `gruckion/nested-subagent`
5. Go to **Discover** tab and install the plugin

### Option 2: Install Locally

```bash
git clone https://github.com/gruckion/nested-subagent.git
cd nested-subagent/mcp-server && npm install
claude /plugin install ./nested-subagent
```

### Option 3: Per-Session (CLI)

```bash
claude --plugin-dir /path/to/nested-subagent
```

## What's Included

| Component | Name | Description |
|-----------|------|-------------|
| MCP Tool | `Task` | Spawns isolated Claude processes with full tool access |
| MCP Tool | `AbortTask` | Cancels a running `Task` out-of-band by `taskId` |

## Example

![Example terminal session showing 3 levels of nesting](assets/example.png)

## Usage

Claude automatically uses the nested subagent tool when your task requires multi-level delegation:

```
Build a math utility that needs its own subagents for verify, plan, and code steps.
```

```
Process these issues where each issue handler spawns specialized workers.
```

```
Run a workflow that delegates to sub-sub-agents for parallel execution.
```

## Why Use This?

Claude Code's native Task tool **blocks subagents from spawning other subagents**:

```typescript
// src/tools/AgentTool/prompt.ts - the recursion blocker
.filter(_ => _.name !== AgentTool.name)
```

This plugin works around that limitation using the official `claude -p` headless mode. Each spawned process runs as an isolated main agent with the same capabilities as your interactive session - including the ability to use the native Task tool.

```
Native Task:     Main → Subagent → BLOCKED (Task tool filtered out)
This Plugin:     Main → Nested → Isolated Main → Subagent → ✓
```

### How It Works

The plugin spawns `claude -p` with `--output-format stream-json` to get real-time progress, matching the native Task tool's behavior:

```bash
claude -p "your task" --output-format stream-json --verbose --model sonnet
```

This is the same approach as the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) - spawning isolated Claude processes programmatically.

---

## Feature Parity with Native Task

| Feature | Native Task | This Plugin | Status |
|---------|-------------|-------------|--------|
| **Can spawn sub-sub-agents** | ❌ Blocked | ✅ Yes | **Why this exists** |
| **Context isolation** | Shared | ✅ Fresh 200k window | ✅ Implemented |
| **Real-time progress** | Generator yields | MCP notifications | ✅ Implemented |
| **Tool use counting** | ✅ | ✅ | ✅ Implemented |
| **Token tracking** | ✅ | ✅ | ✅ Implemented |
| **Cost tracking** | ✅ | ✅ | ✅ Implemented |
| **Abort / cancel** | AbortController | SIGTERM / SIGKILL + sibling `AbortTask` tool | ✅ Implemented |
| **Configurable model** | ❌ | ✅ sonnet / opus / haiku | ✅ Implemented |
| **Configurable timeout** | ❌ | ✅ | ✅ Implemented |
| **System prompt control** | ❌ | ✅ Full control | ✅ Implemented |
| **Tool restrictions** | ❌ | ✅ allowed / disallowed | ✅ Implemented |
| **Budget limits** | ❌ | ✅ maxBudgetUsd | ✅ Implemented |
| **Extended thinking budget** | ❌ | ✅ effort low/medium/high/xhigh/max | ✅ Implemented |
| **Resume support** | ✅ --resume | ✅ resume / continue / sessionId / fork | ✅ Implemented |
| **Background execution** | ✅ run_in_background | ❌ | 🔲 Planned |
| **Normalized messages** | ✅ Full tree | Text only | 🔲 Planned |
| **Sidechain logging** | ✅ .claude/logs | ❌ | 🔲 Planned |
| **Task aggregation** | N/A | ❌ | 🔲 Planned |

### Legend

- ✅ Implemented
- 🔲 Planned
- ❌ Not available

## Tool Reference

### `mcp__plugin_nested-subagent_nested__Task`

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | string | **Required.** The task for the agent |
| `description` | string | Short summary for UI display (3-5 words) |
| `model` | string | `sonnet`, `opus`, or `haiku` (default: sonnet) |
| `effort` | string | `low` / `medium` / `high` / `xhigh` / `max` — extended thinking budget. Omit for `claude`'s default |
| `allowWrite` | boolean | Enable write permissions |
| `permissionMode` | string | `acceptEdits` / `auto` / `bypassPermissions` / `default` / `dontAsk` / `plan`. Default `auto`. Ignored when `allowWrite` is true |
| `timeout` | number | Timeout in ms (default: 600000) |
| `systemPrompt` | string | Custom system prompt |
| `allowedTools` | string[] | Restrict to specific tools |
| `maxBudgetUsd` | number | Cost limit for the task |
| `sessionId` | string | Specific session UUID (`--session-id`). Combined with `resume`/`continueRecent` requires `forkSession` |
| `resume` | string | Resume an existing session by UUID (`--resume`). Implies `persistSession: true` |
| `continueRecent` | boolean | Resume the most recent session in `workingDir` (`--continue`). Implies `persistSession: true` |
| `forkSession` | boolean | When resuming, create a new session ID (`--fork-session`). Requires `resume` or `continueRecent` |
| `persistSession` | boolean | Default `false`. When `true` (or implied by any resume param), the session is saved and can be resumed later |
| `taskId` | string | Optional handle for `AbortTask`. If omitted, auto-generated and reported in the first progress notification |

The result text ends with a trailer that callers can parse:

```
Done (N tool uses · Xk tokens · Ys)
task_id: <id>
session_id: <uuid>
persisted: true|false
```

### `mcp__plugin_nested-subagent_nested__AbortTask`

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | **Required.** The handle returned from `Task` (either supplied by the caller or emitted in the first progress notification as `taskId=…`) |
| `signal` | string | `SIGTERM` (default), `SIGINT`, or `SIGKILL` |

Returns one of:

- `aborted` — signal delivered to a live child process
- `pending` — task is mid-spawn; the abort is queued and will fire when the child attaches
- `not_found` — no active task with that id
- `already_exited` — task found but the child has already terminated

Intended for out-of-band orchestration: a separate MCP client (or a parallel tool call) can cancel work without waiting for the original `Task` call to return.

### Example: Resuming a session

```jsonc
// Call 1 — persist a fresh session
{
  "name": "Task",
  "arguments": {
    "prompt": "Remember the word ALPHA for later.",
    "persistSession": true,
    "model": "haiku"
  }
}
// Result text ends with: session_id: <uuid>

// Call 2 — resume with the captured session_id
{
  "name": "Task",
  "arguments": {
    "prompt": "What word did I ask you to remember?",
    "resume": "<uuid from call 1>",
    "model": "haiku"
  }
}
```

## Architecture

For deep technical details on how this works, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

MIT - see [LICENSE](./LICENSE) for details.
