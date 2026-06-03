/**
 * Nested Subagent MCP Server - Streaming Edition
 *
 * This MCP server enables unlimited nested subagents by spawning fresh Claude
 * processes with REAL-TIME progress streaming using MCP progress notifications.
 *
 * KEY FEATURES:
 * - Uses `claude -p --output-format stream-json --verbose` for real-time streaming
 * - Emits MCP progress notifications for each tool use
 * - Supports abort via SIGTERM (graceful) and SIGKILL (forced)
 * - Passes through all relevant CLI options to match native Task tool behavior
 *
 * Architecture:
 * ```
 * Main Plugin Session
 *     └── MCP Tool: spawn_subagent({prompt, progressToken})
 *             │
 *             ├── Spawns: claude -p --output-format stream-json --verbose
 *             │
 *             ├── Parses streaming JSON line by line
 *             │
 *             ├── Emits: notifications/progress for each tool_use
 *             │
 *             └── Returns final result when complete
 * ```
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { appendFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type ActiveTaskEntry,
  type AssistantContentBlock,
  type ProgressState,
  type RunTaskResult,
  type TaskInput,
  buildClaudeArgs,
  buildTaskPayload,
  computeEffectivePersist,
  handleAbort,
  handleAssistantContent,
  handleUserContent,
  parseNeedsInput,
  shutdownChildren,
  validatePermissionParams,
  validateSessionParams,
} from "./session.js";
import pkg from "../package.json" with { type: "json" };

// Debug log lives in os.tmpdir() with mode 0600 — the file captures prompts,
// system prompts, and child stderr, so it must not be world-readable on
// shared hosts. The filename is per-pid so nested spawns (each running its
// own MCP server) don't clobber the parent's log on startup.
const LOG_FILE = join(tmpdir(), `nested-subagent-debug-${process.pid}.log`);
function log(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {
    // Ignore logging errors
  }
}

// Initialize log file. Unlink first so writeFileSync's mode option applies
// — it's only honored on file creation, not when truncating an existing file.
try {
  try { unlinkSync(LOG_FILE); } catch {}
  writeFileSync(LOG_FILE, `=== Nested Subagent MCP Server Started ===\n`, { mode: 0o600 });
  appendFileSync(LOG_FILE, `CLAUDE_PLUGIN_ROOT=${process.env.CLAUDE_PLUGIN_ROOT || '(not set)'}\n`);
} catch {
  // Ignore
}

// Types for Claude CLI stream-json output
interface UserToolResultBlock {
  type: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface StreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  message?: {
    content: Array<AssistantContentBlock | UserToolResultBlock>;
    // Present on assistant events — the resolved model the subagent ran (e.g.
    // "claude-opus-4-8"). The CLI strips any [1m] suffix before the API call,
    // so this reports the base id, not the 1M flag.
    model?: string;
  };
  session_id?: string;
  uuid?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Object on success, bare string on error/permission-denied paths.
  tool_use_result?:
    | string
    | { stdout?: string; stderr?: string; interrupted?: boolean };
}

// Tool definition - named "Task" to match native Task tool UX
const NESTED_TASK_TOOL: Tool = {
  name: "Task",
  description: `Spawn an isolated Claude subagent in a fresh process with its own 200k-token context, full tool access (Bash, Read, Edit, Web, MCP — including this Task tool itself, so nesting works to any depth), and an independent permission scope.

When to use:
- Multi-step delegation that would otherwise inflate your context with intermediate tool outputs.
- Parallel research: launch several Task calls in one message (single message, multiple tool_uses) and they run concurrently.
- Long-running or token-heavy work whose final answer is small (the subagent absorbs the bulk; you get a structured summary).

Output: JSON conforming to outputSchema. Key fields: \`ok\` (boolean discriminator), \`result\` (subagent's final text on success), \`error\` + \`errorKind\` on failure, \`taskId\`, \`sessionId\`, \`persisted\`, \`stats\`, \`toolUseSummary\`. Raw tool stdout is omitted unless you pass \`includeToolOutputs: true\`.

Session chaining: pass \`persistSession: true\` (or \`resume\`/\`continueRecent\`/\`sessionId\`), read \`sessionId\` from the response, then pass \`resume: "<id>"\` on the next call.

Abort: pass an explicit \`taskId\` (or read the auto-generated one from the first progress notification) and call the sibling \`AbortTask\` tool.

Defaults: model=opus[1m], effort=xhigh, allowWrite=false, permissionMode=auto, persistSession=false, timeout=600000ms. When allowWrite=false (the default), Write/Edit/NotebookEdit are added to --disallowed-tools and the subagent is told it is in read-only-files mode.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "The task for the agent to perform",
      },
      model: {
        type: "string",
        default: "opus[1m]",
        examples: ["opus[1m]", "opus", "sonnet", "sonnet[1m]", "haiku", "claude-opus-4-8"],
        description:
          "Model for the subagent. Accepts an alias (opus/sonnet/haiku), a full model id (e.g. claude-opus-4-8), or a 1M-context variant by appending [1m] (Opus/Sonnet only — Haiku has no 1M context). Any value the installed `claude` CLI accepts is allowed, including models released after this plugin. Passed verbatim to --model. Default: opus[1m] (latest Opus with 1M context).",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        default: "xhigh",
        description: "Extended thinking budget for the spawned subagent (maps to --effort). Default: xhigh.",
      },
      workingDir: {
        type: "string",
        description: "Working directory (defaults to current)",
      },
      timeout: {
        type: "number",
        default: 600000,
        description: "Timeout in ms (default: 10 minutes)",
      },
      allowWrite: {
        type: "boolean",
        default: false,
        description: "Narrow gate on file-modifying tools. When false (default), Write/Edit/NotebookEdit are appended to --disallowed-tools and a read-only-files system-prompt note is added so the subagent plans around the restriction. When true, those tools are permitted (subject to permissionMode). Note: Bash is NOT blocked — shell-based file writes (`bash -c 'echo x > file'`, `sed -i`, `tee`, etc.) remain possible and are only discouraged via the system-prompt note.",
      },
      permissionMode: {
        type: "string",
        enum: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"],
        default: "auto",
        description: "Permission mode for the spawned subagent (default: auto). Mutually exclusive with dangerouslySkipPermissions.",
      },
      dangerouslySkipPermissions: {
        type: "boolean",
        default: false,
        description: "Adds --dangerously-skip-permissions, which disables ALL permission prompts (file writes, Bash, MCP tools, etc.). Mutually exclusive with permissionMode. Use this only when you really want to bypass every prompt; for the narrow case of allowing file writes only, use allowWrite=true.",
      },
      systemPrompt: {
        type: "string",
        description: "Custom system prompt for the spawned subagent",
      },
      appendSystemPrompt: {
        type: "string",
        description: "Append to default system prompt",
      },
      allowedTools: {
        type: "array",
        items: { type: "string" },
        description: "List of allowed tools (e.g., ['Bash', 'Read', 'Edit'])",
      },
      disallowedTools: {
        type: "array",
        items: { type: "string" },
        description: "List of disallowed tools",
      },
      maxBudgetUsd: {
        type: "number",
        description: "Maximum API cost budget in USD",
      },
      addDirs: {
        type: "array",
        items: { type: "string" },
        description: "Additional directories to allow access to",
      },
      sessionId: {
        type: "string",
        description:
          "Specific session UUID for the new session (maps to --session-id). When combined with resume/continueRecent, forkSession must also be true.",
      },
      resume: {
        type: "string",
        description:
          "Resume an existing session by UUID (maps to --resume). Implies persistSession=true; mutually exclusive with continueRecent.",
      },
      continueRecent: {
        type: "boolean",
        description:
          "Resume the most recent session in workingDir (maps to --continue). Implies persistSession=true; mutually exclusive with resume.",
      },
      forkSession: {
        type: "boolean",
        description:
          "When resuming, create a new session ID instead of reusing the original (maps to --fork-session). Requires resume or continueRecent.",
      },
      persistSession: {
        type: "boolean",
        description:
          "Persist the session to disk so it can be resumed later. Default false (adds --no-session-persistence). Setting this to false alongside resume/continueRecent/sessionId/forkSession is rejected.",
      },
      taskId: {
        type: "string",
        description:
          "Optional handle for out-of-band abort via the AbortTask tool. If omitted, an id is auto-generated and emitted in the first progress notification.",
      },
      includeToolOutputs: {
        type: "boolean",
        default: false,
        description:
          "If true, append raw stdout from each tool the subagent used to the response under `toolOutputs`. Default false — the parent receives only `toolUseSummary` counts, so the subagent absorbs bulk tokens. Each output is truncated to 16 KB.",
      },
      includeThinking: {
        type: "boolean",
        default: false,
        description:
          "If true, append the subagent's extended-thinking content to the response under `thinkingBlocks` (each entry truncated to 16 KB). Default false — the parent receives only `stats.thinkingBlocks` count, since intermediate reasoning is what subagent isolation absorbs. Two block shapes are counted but excluded from the surfaced array: redacted thinking (encrypted blob the parent can't decrypt) and empty-text thinking (Opus 4.x sometimes emits a signed-but-empty `{thinking: \"\"}` block when extended thinking is enabled but the model has no reasoning text for that turn). The result: `stats.thinkingBlocks >= thinkingBlocks.length`.",
      },
      askOperator: {
        type: "boolean",
        default: false,
        description:
          "Operator escape hatch. When true, instructs the subagent (via --append-system-prompt) to emit a sentinel-wrapped JSON block in its final message instead of calling AskUserQuestion (which is unavailable in headless mode); the plugin parses that block and returns it as `needsInput`. The parent should call its own AskUserQuestion with `needsInput.questions`, then re-invoke Task with `resume: <sessionId>` and a prompt containing the answers. Implies persistSession=true. Detection is opt-in: sentinels emitted while askOperator=false are ignored. See ARCHITECTURE.md → Operator escape hatch for rationale.",
      },
    },
    required: ["prompt"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      ok: {
        type: "boolean",
        description: "True on successful subagent completion.",
      },
      taskId: {
        type: "string",
        description: "Handle for AbortTask. Always present.",
      },
      sessionId: {
        type: "string",
        description:
          "Claude session UUID. Present whenever the system event fired (almost always, even on most failures).",
      },
      persisted: {
        type: "boolean",
        description:
          "Whether the session was written to disk and can be resumed via `resume: <sessionId>` on a follow-up call.",
      },
      result: {
        type: "string",
        description:
          "Subagent's final assistant message. Present iff ok=true.",
      },
      error: {
        type: "string",
        description: "Human-readable failure reason. Present iff ok=false.",
      },
      errorKind: {
        type: "string",
        enum: [
          "timeout",
          "spawn_failed",
          "validation",
          "exit_nonzero",
          "aborted",
        ],
        description: "Programmatic failure category. Present iff ok=false.",
      },
      stats: {
        type: "object",
        properties: {
          toolUseCount: { type: "integer" },
          model: {
            type: "string",
            description:
              "The model the subagent actually ran (e.g. claude-opus-4-8). Reported by the CLI without the [1m] suffix, which the API strips before the request.",
          },
          durationMs: { type: "integer" },
          tokens: {
            type: "integer",
            description:
              "input + output + cache_creation (billed at standard rate).",
          },
          cacheReadTokens: {
            type: "integer",
            description:
              "Tokens read from cache, billed separately at a reduced rate.",
          },
          costUsd: { type: "number" },
          thinkingBlocks: {
            type: "integer",
            description:
              "Count of every thinking-shaped content block the subagent emitted: thinking (with or without text) + redacted_thinking. Present only when > 0. May exceed `thinkingBlocks.length` because redacted and empty-text blocks are counted here but excluded from the surfaced array.",
          },
        },
      },
      toolUseSummary: {
        type: "array",
        description:
          "Counts of each tool the subagent invoked. Cheap to include; gives the parent visibility into what happened without dumping outputs.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            count: { type: "integer" },
          },
          required: ["tool", "count"],
        },
      },
      toolOutputs: {
        type: "array",
        description:
          "Raw stdout per tool invocation. Present only when the caller passed `includeToolOutputs: true`. Each output truncated to 16 KB.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            output: { type: "string" },
          },
          required: ["tool", "output"],
        },
      },
      thinkingBlocks: {
        type: "array",
        description:
          "Subagent's extended-thinking content. Present only when the caller passed `includeThinking: true`. Two block shapes are counted in `stats.thinkingBlocks` but excluded from this array: redacted thinking (encrypted) and empty-text thinking (signed `{thinking: \"\"}` blocks that Opus 4.x emits when extended thinking is enabled but the model has no reasoning text for the turn). Each entry truncated to 16 KB.",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
      needsInput: {
        type: "object",
        description:
          "Present only when askOperator=true was passed AND the subagent emitted a valid sentinel-wrapped operator-input request in its final message. Mirrors the native AskUserQuestion input shape so the parent can pass `questions` straight through. The parent should call AskUserQuestion with these questions, then call Task again with `resume: <sessionId>` and a prompt containing the operator's answers.",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                header: { type: "string", maxLength: 12 },
                multiSelect: { type: "boolean" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                      preview: { type: "string" },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["question", "header", "multiSelect", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    required: ["ok", "taskId"],
  },
};

const ABORT_TASK_TOOL: Tool = {
  name: "AbortTask",
  description: `Abort a running Task that was launched via the sibling Task tool.

Lookup is by \`taskId\` — either the value the caller passed to Task, or the auto-generated id emitted in Task's first progress notification (\`taskId=...\`).

Returns one of:
- \`aborted\` — task was running; the requested signal was delivered to the child process.
- \`pending\` — task is mid-spawn (child not yet attached); the abort is queued and will fire the moment the spawn completes.
- \`not_found\` — no active task with that id.
- \`already_exited\` — task was found but the child process has already terminated.

This is intended for out-of-band orchestration: a separate MCP client (or a sibling tool call) can cancel work without waiting for the original Task call to return.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: {
        type: "string",
        description: "Task handle to abort",
      },
      signal: {
        type: "string",
        enum: ["SIGTERM", "SIGINT", "SIGKILL"],
        default: "SIGTERM",
        description: "POSIX signal to deliver (default SIGTERM)",
      },
    },
    required: ["taskId"],
  },
};

// Create MCP server
const server = new Server(
  {
    name: "nested-subagent",
    version: pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Track active tasks for abort handling. The entry is registered before
// `spawn()` returns (with `proc: null`) so an AbortTask call that races the
// spawn can queue itself; the spawn path consults `abortRequested` once the
// real ChildProcess is attached and kills immediately if so.
const activeProcesses = new Map<string, ActiveTaskEntry>();

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Spawns a nested task (fresh Claude process) with streaming output
 */
async function runTask(
  input: TaskInput,
  progressToken?: string | number,
): Promise<RunTaskResult> {
  const validationError =
    validateSessionParams(input) ?? validatePermissionParams(input);
  if (validationError) {
    return {
      success: false,
      error: validationError,
      errorKind: "validation",
    };
  }

  const workingDir = input.workingDir ?? process.cwd();
  const timeout = input.timeout ?? 600000;
  const persisted = computeEffectivePersist(input);

  const taskId = input.taskId ?? generateTaskId();
  if (input.taskId && activeProcesses.has(taskId)) {
    return {
      success: false,
      error: `taskId collision: ${taskId} is already active`,
      errorKind: "validation",
      taskId,
    };
  }

  const args = buildClaudeArgs(input, {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
  });

  const state: ProgressState = {
    toolUseCount: 0,
    toolUseNamesById: new Map<string, string>(),
    startTime: Date.now(),
    toolOutputs: [],
    toolUseCounts: new Map<string, number>(),
    thinkingBlockCount: 0,
    thinkingBlocks: [],
  };

  // Reserve the entry synchronously so AbortTask calls that arrive during
  // (or even before) spawn can queue themselves against this taskId.
  activeProcesses.set(taskId, { proc: null, abortRequested: false });

  if (progressToken !== undefined) {
    server.notification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: 0,
        message: `Task · taskId=${taskId}`,
      },
    });
  }

  return new Promise((resolve) => {
    let lastResult: StreamMessage | null = null;
    let capturedSessionId: string | undefined;
    let capturedModel: string | undefined;
    let timedOut = false;

    log(`[${taskId}] CLAUDE_PLUGIN_ROOT=${process.env.CLAUDE_PLUGIN_ROOT || '(not set)'}`);
    log(`[${taskId}] Spawning claude with args: ${JSON.stringify(args)}`);
    log(`[${taskId}] Working dir: ${workingDir}`);

    const proc = spawn("claude", args, {
      cwd: workingDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    log(`[${taskId}] Process spawned with PID: ${proc.pid}`);

    // Close stdin immediately - Claude with -p doesn't need it
    proc.stdin?.end();
    log(`[${taskId}] stdin closed`);

    // Attach the real ChildProcess to the placeholder. If AbortTask was called
    // while we were spawning, deliver the queued signal immediately.
    const entry = activeProcesses.get(taskId);
    if (entry) {
      entry.proc = proc;
      if (entry.abortRequested) {
        const sig = entry.abortSignal ?? "SIGTERM";
        log(`[${taskId}] Delivering queued abort signal: ${sig}`);
        proc.kill(sig);
      }
    }

    // Timeout handling
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }, timeout);

    const rl = createInterface({ input: proc.stdout! });

    rl.on("line", (line) => {
      log(`[${taskId}] STDOUT line: ${line.slice(0, 200)}${line.length > 200 ? '...' : ''}`);
      if (!line.trim()) return;

      try {
        const msg: StreamMessage = JSON.parse(line);

        switch (msg.type) {
          case "system":
            if (msg.session_id) capturedSessionId = msg.session_id;
            if (progressToken !== undefined) {
              server.notification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: 0,
                  message: `Session initialized (${msg.session_id?.slice(0, 8)}...)`,
                },
              });
            }
            break;

          case "assistant":
            if (!capturedModel && typeof msg.message?.model === "string" && msg.message.model) {
              capturedModel = msg.message.model;
            }
            if (msg.message?.content) {
              const { progressMessages, unknownBlockTypes } =
                handleAssistantContent(msg.message.content, state);
              if (progressToken !== undefined) {
                for (const message of progressMessages) {
                  server.notification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: state.toolUseCount,
                      message,
                    },
                  });
                }
              }
              for (const t of unknownBlockTypes) {
                log(`[${taskId}] Unknown assistant content block type: ${t}`);
              }
            }
            break;

          case "user":
            if (msg.tool_use_result !== undefined) {
              handleUserContent(msg.message, msg.tool_use_result, state);
              if (progressToken !== undefined) {
                const stdout =
                  typeof msg.tool_use_result === "object" &&
                  msg.tool_use_result !== null
                    ? msg.tool_use_result.stdout ?? ""
                    : "";
                const resultPreview = stdout.slice(0, 50) || "(no output)";
                server.notification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: state.toolUseCount,
                    message: `Result: ${resultPreview}${stdout.length > 50 ? "..." : ""}`,
                  },
                });
              }
            }
            break;

          case "result":
            lastResult = msg;
            break;
        }
      } catch {
        // Ignore JSON parse errors (might be partial lines)
      }
    });

    // Collect stderr for errors. Drain it explicitly before resolving so a
    // buffered chunk emitted in the same tick as `close` isn't lost.
    let stderr = "";
    const stderrDrained = new Promise<void>((resolveDrain) => {
      if (!proc.stderr) {
        resolveDrain();
        return;
      }
      proc.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        log(`[${taskId}] STDERR: ${chunk}`);
      });
      proc.stderr.once("end", () => resolveDrain());
      proc.stderr.once("error", () => resolveDrain());
    });

    proc.on("close", async (code: number | null, signal: NodeJS.Signals | null) => {
      await stderrDrained;
      log(`[${taskId}] Process closed with code: ${code}, signal: ${signal}`);
      clearTimeout(timeoutId);
      activeProcesses.delete(taskId);
      const duration = Date.now() - state.startTime;
      log(`[${taskId}] Duration: ${duration}ms, timedOut: ${timedOut}, hasResult: ${!!lastResult}`);

      const toolUseSummary = Array.from(state.toolUseCounts.entries())
        .map(([tool, count]) => ({ tool, count }));

      if (timedOut) {
        log(`[${taskId}] Resolving with timeout error`);
        resolve({
          success: false,
          error: `Task timed out after ${timeout}ms`,
          errorKind: "timeout",
          taskId,
          sessionId: capturedSessionId,
          model: capturedModel,
          persisted,
          toolUseCount: state.toolUseCount,
          duration,
          toolUseSummary,
          thinkingBlockCount: state.thinkingBlockCount,
          thinkingBlocks: state.thinkingBlocks,
        });
        return;
      }

      if (lastResult) {
        // Tokens billed at the standard rate. Cache reads are billed at a
        // reduced rate and tracked separately so callers can see the split.
        const totalTokens = lastResult.usage
          ? (lastResult.usage.cache_creation_input_tokens ?? 0) +
          lastResult.usage.input_tokens +
          lastResult.usage.output_tokens
          : 0;
        const cacheReadTokens = lastResult.usage?.cache_read_input_tokens ?? 0;

        if (progressToken !== undefined) {
          server.notification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: state.toolUseCount,
              total: state.toolUseCount,
              message: `Done (${state.toolUseCount} tool uses, ${duration}ms, $${lastResult.total_cost_usd?.toFixed(4) ?? "?"})`,
            },
          });
        }

        const successFlag = !lastResult.is_error;
        const needsInput =
          successFlag && input.askOperator
            ? parseNeedsInput(lastResult.result) ?? undefined
            : undefined;

        resolve({
          success: successFlag,
          result: lastResult.result,
          errorKind: lastResult.is_error ? "exit_nonzero" : undefined,
          toolUseCount: state.toolUseCount,
          duration,
          tokens: totalTokens,
          cacheReadTokens,
          costUsd: lastResult.total_cost_usd,
          toolOutputs: state.toolOutputs,
          toolUseSummary,
          thinkingBlockCount: state.thinkingBlockCount,
          thinkingBlocks: state.thinkingBlocks,
          sessionId: capturedSessionId,
          model: capturedModel,
          persisted,
          taskId,
          needsInput,
        });
      } else if (code === 0) {
        resolve({
          success: true,
          result: "(completed with no output)",
          toolUseCount: state.toolUseCount,
          duration,
          tokens: 0,
          toolOutputs: state.toolOutputs,
          toolUseSummary,
          thinkingBlockCount: state.thinkingBlockCount,
          thinkingBlocks: state.thinkingBlocks,
          sessionId: capturedSessionId,
          model: capturedModel,
          persisted,
          taskId,
        });
      } else {
        // Externally killed (e.g. AbortTask SIGTERM/SIGKILL) versus a child
        // that exited non-zero on its own. `timedOut` is already handled above.
        const aborted = signal !== null;
        resolve({
          success: false,
          error: aborted
            ? `Aborted by signal ${signal}`
            : stderr.trim() || `Process exited with code ${code}`,
          errorKind: aborted ? "aborted" : "exit_nonzero",
          sessionId: capturedSessionId,
          model: capturedModel,
          persisted,
          toolUseCount: state.toolUseCount,
          duration,
          toolUseSummary,
          thinkingBlockCount: state.thinkingBlockCount,
          thinkingBlocks: state.thinkingBlocks,
          taskId,
        });
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      activeProcesses.delete(taskId);
      resolve({
        success: false,
        error: `Failed to spawn: ${err.message}`,
        errorKind: "spawn_failed",
        taskId,
      });
    });
  });
}

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [NESTED_TASK_TOOL, ABORT_TASK_TOOL],
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log(`Tool called: ${request.params.name}`);

  if (request.params.name === "AbortTask") {
    const args = request.params.arguments as
      | { taskId?: string; signal?: NodeJS.Signals }
      | undefined;
    const taskId = args?.taskId;
    const signal = args?.signal ?? "SIGTERM";
    if (!taskId) {
      return {
        content: [{ type: "text", text: "Error: taskId is required" }],
        isError: true,
      };
    }
    const outcome = handleAbort(activeProcesses, taskId, signal);
    log(`AbortTask(${taskId}, ${signal}) -> ${outcome}`);
    const isError = outcome === "not_found";
    return {
      content: [{ type: "text", text: outcome }],
      ...(isError ? { isError: true } : {}),
    };
  }

  if (request.params.name !== "Task") {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const input = request.params.arguments as unknown as TaskInput;
  const progressToken = request.params._meta?.progressToken;

  log(`Prompt: ${input.prompt?.slice(0, 100)}...`);
  log(
    `Model: ${input.model}, timeout: ${input.timeout}, allowWrite: ${input.allowWrite}, dangerouslySkipPermissions: ${input.dangerouslySkipPermissions}`,
  );

  if (!input.prompt) {
    return {
      content: [{ type: "text", text: "Error: prompt is required" }],
      isError: true,
    };
  }

  const result = await runTask(input, progressToken);
  log(`Result: success=${result.success}, error=${result.error}`);

  const payload = buildTaskPayload(
    result,
    Boolean(input.includeToolOutputs),
    Boolean(input.includeThinking),
  );
  const text = JSON.stringify(payload);

  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
    ...(payload.ok ? {} : { isError: true }),
  };
});

// Graceful shutdown - abort all active processes
process.on("SIGTERM", () => shutdownChildren(activeProcesses, "SIGTERM"));
process.on("SIGINT", () => shutdownChildren(activeProcesses, "SIGINT"));

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Nested Subagent MCP Server v${pkg.version} (streaming) running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
