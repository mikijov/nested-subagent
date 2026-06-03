# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Claude Code plugin that enables **unlimited nested subagents**. The native Task tool's `AgentTool` filters itself out of subagent tool lists (`src/tools/AgentTool/prompt.ts` in the Claude Code source), so subagents cannot spawn further subagents. This plugin sidesteps that by exposing an MCP `Task` tool that spawns a fresh `claude -p` subprocess — a brand-new main agent with full tool access, including the native Task tool.

### Naming

The repo, plugin, and MCP server all use slightly different names — keep them straight:

- Repo directory: `nested-subagent`
- Plugin name (`.claude-plugin/marketplace.json`): `nested-subagent`
- MCP server name (`.mcp.json`): `nested`
- Exposed tool: `mcp__plugin_nested-subagent_nested__Task`

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
# Or add marketplace `mikijov/nested-subagent` via the /plugin UI
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
  [--effort <level>] \
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
- Permission validation lives in `validatePermissionParams` (`session.ts`). Rule: `dangerouslySkipPermissions` and `permissionMode` are mutually exclusive (the former disables all prompt machinery, making the latter meaningless).
- `allowWrite=false` (the default) appends `Write`/`Edit`/`NotebookEdit` to `--disallowed-tools` (merged + deduped with any caller-supplied `disallowedTools`) and appends `READ_ONLY_FILES_PROMPT` to `--append-system-prompt` (joined to any caller-supplied `appendSystemPrompt` with `\n\n`). Bash is intentionally not blocked — `sed -i`, redirects, and `tee` remain functional escape hatches and are only discouraged via the system-prompt note.
- `activeProcesses` is `Map<string, ActiveTaskEntry>`. Entries are registered with `proc: null` **before** `spawn()` returns so an `AbortTask` call that races the spawn can queue a signal; the spawn path delivers the queued signal once it attaches the real `ChildProcess`.
- Timeout: `SIGTERM`, then `SIGKILL` 5s later. All active entries are torn down on `SIGTERM`/`SIGINT` to the server itself.
- Debug log: `<os.tmpdir()>/nested-subagent-debug-<pid>.log`, created with mode `0600` so prompts and stderr don't leak to other local users. Per-pid so nested spawns (each running its own MCP server) don't clobber the parent's log on startup. Overwritten on each server start.
- Persistent sessions accumulate under `~/.claude/sessions/`. The plugin does not clean them up.
- `askOperator` semantics live in three places in `session.ts`: (a) `ASK_OPERATOR_PROMPT` is the system-prompt snippet appended when the flag is on; (b) `computeEffectivePersist` treats `askOperator` as implying persistence, so `--no-session-persistence` is suppressed and the resulting `sessionId` is durable for the parent's resume call; (c) `parseNeedsInput` scans `lastResult.result` (the `result` event's final assistant text) for the sentinel pair, validates the JSON shape strictly, and returns `null` on any failure. Failures are silent — a malformed sentinel block becomes a normal `ok: true` with no `needsInput`, leaving the raw text in `result` for the caller to inspect. Parsing only runs when `success: true` AND `askOperator: true` was passed; a sentinel block emitted by a subagent the caller did NOT opt in for is ignored. Parsing also does NOT run on the failure / no-result branches.
- `needsInput` and `result` co-exist on a "needs input" success: `result` is the raw subagent final text (including the sentinel block — kept verbatim for debugging), `needsInput` is the parsed structured form. Callers should branch on `needsInput`, not on `result.includes(...)`. Trailing text after `<<<END_OPERATOR_INPUT>>>` is preserved verbatim in `result` — the parser does not strip it.
- We do not police what the caller disables via `disallowedTools` when `askOperator: true`. A caller who blocks tools the subagent needs to complete the work will see normal `exit_nonzero` failures. The escape hatch is about communicating questions, not about guaranteeing the subagent can do anything useful.
- **No `--fallback-model` by design.** The plugin deliberately omits `--fallback-model` and exposes no `fallbackModel` parameter. With defaults `model: opus[1m], effort: xhigh`, a silent fallback to Sonnet on overload would degrade quality undetectably. (The plugin *does* now capture the resolved model from `assistant` events into `stats.model`, but that reflects what the spawn started with, not a mid-run provider downgrade, and it reports the base id without the `[1m]` suffix — the CLI strips it before the API call.) Anthropic provider-side overloads surface as `errorKind: "exit_nonzero"` after the CLI's internal retry/backoff loop; the caller decides whether to retry later. Note: this addresses provider overload (e.g. HTTP 529), not account quota / rate-limit errors. See `ARCHITECTURE.md` → *No fallback model* before adding fallback logic.

## Tool parameters

### `mcp__plugin_nested-subagent_nested__Task`

Schema lives in `mcp-server/src/index.ts` (`NESTED_TASK_TOOL.inputSchema`); the shared `TaskInput` type and helpers are in `mcp-server/src/session.ts`.

| Parameter            | Type     | Notes                                                                |
|----------------------|----------|----------------------------------------------------------------------|
| `prompt`             | string   | Required.                                                            |
| `model`              | string   | Default `opus[1m]` (latest Opus + 1M context). **Open-ended — passed verbatim to `--model` with no validation.** Accepts an alias (`opus`/`sonnet`/`haiku`), a full id (`claude-opus-4-8`), or a 1M-context variant by appending `[1m]` (Opus/Sonnet only — Haiku has no 1M). Any value the installed `claude` CLI accepts works, including models released after this plugin. |
| `effort`             | enum     | `low` \| `medium` \| `high` \| `xhigh` \| `max`. Maps to `--effort` (extended thinking budget). Default `xhigh` (always emitted). |
| `workingDir`         | string   | Defaults to `process.cwd()`.                                         |
| `timeout`            | number   | Milliseconds. Default `600000` (10 min).                             |
| `allowWrite`         | boolean  | Default `false`. **Narrow gate on file-modifying tools.** When `false`, `Write`/`Edit`/`NotebookEdit` are appended to `--disallowed-tools` and a read-only-files note is appended to `--append-system-prompt`. When `true`, those tools are permitted (subject to `permissionMode`). Bash is **not** blocked — shell-based writes (`sed -i`, `>` redirects, `tee`) remain possible and are only discouraged via the system-prompt note. |
| `permissionMode`     | enum     | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan`. Default `auto`. Mutually exclusive with `dangerouslySkipPermissions`. |
| `dangerouslySkipPermissions` | boolean | Default `false`. Adds `--dangerously-skip-permissions`, disabling **all** permission prompts (file writes, Bash, MCP, etc.). Mutually exclusive with `permissionMode`. For the narrow case of "allow file edits only", use `allowWrite: true` instead. |
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
| `includeToolOutputs` | boolean  | Default `false`. When `true`, the response payload includes a `toolOutputs` array with raw stdout from each tool the subagent ran (each entry truncated to 16 KB). Default omits these to keep the parent's context small. |
| `includeThinking`    | boolean  | Default `false`. When `true`, the response payload includes a `thinkingBlocks` array with the subagent's extended-thinking text (each entry truncated to 16 KB). Two shapes are counted in `stats.thinkingBlocks` but excluded from the array: **redacted** thinking (encrypted blob the parent can't decrypt) and **empty-text** thinking (signed `{thinking: ""}` blocks Opus 4.x emits when extended thinking is enabled but the model has no reasoning text for that turn — the signature satisfies API continuity; the empty string is noise). |
| `askOperator`        | boolean  | Default `false`. **Operator escape hatch.** When `true`, appends a protocol snippet to `--append-system-prompt` telling the subagent it cannot reach `AskUserQuestion` and must instead emit a `<<<NEED_OPERATOR_INPUT>>>…<<<END_OPERATOR_INPUT>>>` JSON block in its final message if it needs operator input. The plugin parses that block out of the subagent's final result text and returns it as `needsInput` on the response. Implies `persistSession: true`; explicit `persistSession: false` is rejected. The `needsInput` shape mirrors native `AskUserQuestion`'s input (1–4 questions, 2–4 options each, `header` ≤ 12 chars) so the parent can pass `needsInput.questions` straight through. Detection is opt-in: sentinel blocks emitted while `askOperator: false` are ignored. Multi-round dialogues compose — a resumed subagent can emit another sentinel block and the cycle repeats. |

The response is a JSON object returned both as `content[0].text` (compact `JSON.stringify`) and mirrored into `structuredContent`. Schema is declared on the tool via `outputSchema`. Shape:

```jsonc
// success
{
  "ok": true,
  "taskId": "task-…",
  "sessionId": "…uuid…",
  "persisted": false,
  "result": "<subagent final text>",
  "stats": {
    "toolUseCount": 5,
    "model": "claude-opus-4-8",
    "durationMs": 45000,
    "tokens": 12400,
    "cacheReadTokens": 3200,
    "costUsd": 0.018,
    "thinkingBlocks": 2
  },
  "toolUseSummary": [{ "tool": "Bash", "count": 3 }, { "tool": "Read", "count": 2 }],
  "thinkingBlocks": [{ "text": "<subagent's intermediate reasoning…>" }]
}

// failure
{
  "ok": false,
  "taskId": "task-…",
  "sessionId": "…",      // present when the system event fired before the failure
  "persisted": false,
  "error": "Task timed out after 600000ms",
  "errorKind": "timeout" // one of: timeout | spawn_failed | validation | exit_nonzero | aborted
}
```

`tokens` = standard-rate billable (`input + output + cache_creation`). `cacheReadTokens` is tracked separately because cache reads are billed at a reduced rate. `stats.model` is the resolved model captured from the first `assistant` event (e.g. `claude-opus-4-8`); it appears whenever the stream carried a model and reports the base id without the `[1m]` suffix (the CLI strips it before the API call), so it confirms which Opus/Sonnet/Haiku ran but not whether 1M context was active. `toolUseSummary` is always included on success; raw `toolOutputs` only when the caller passes `includeToolOutputs: true`. `stats.thinkingBlocks` (count of every thinking-shaped block — `thinking` with or without text, plus `redacted_thinking`) appears whenever the count > 0; raw `thinkingBlocks` only when `includeThinking: true`. The array excludes both redacted entries (encrypted) and empty-text entries (the signed `{thinking: ""}` placeholder Opus 4.x sometimes emits), so `stats.thinkingBlocks >= thinkingBlocks.length`. The same 16 KB UTF-8 truncator (`truncateUtf8` in `session.ts`) applies to both `toolOutputs` and `thinkingBlocks`.

When `askOperator: true` and the subagent emits a valid sentinel block, the success payload also carries `needsInput: { questions: [{ question, header, multiSelect, options: [{ label, description, preview? }, …] }, …] }` alongside the raw `result` text. The parent should branch on `needsInput`, not substring-match `result`. To deliver answers, call `Task` again with `resume: <sessionId>` and a freeform prompt containing the operator's choices.

### `mcp__plugin_nested-subagent_nested__AbortTask`

| Parameter | Type   | Notes                                                                                          |
|-----------|--------|------------------------------------------------------------------------------------------------|
| `taskId`  | string | Required. The handle from `Task.taskId` (caller-supplied or auto-generated, in progress msg). |
| `signal`  | enum   | `SIGTERM` (default) \| `SIGINT` \| `SIGKILL`.                                                 |

Returns one of: `aborted` (signal delivered), `pending` (queued — proc not yet attached), `not_found` (no such taskId), `already_exited`.
