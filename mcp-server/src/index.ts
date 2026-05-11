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
  type ErrorKind,
  type TaskInput,
  buildClaudeArgs,
  computeEffectivePersist,
  handleAbort,
  shutdownChildren,
  validatePermissionParams,
  validateSessionParams,
} from "./session.js";

// Debug log lives in os.tmpdir() with mode 0600 — the file captures prompts,
// system prompts, and child stderr, so it must not be world-readable on
// shared hosts.
const LOG_FILE = join(tmpdir(), "nested-subagent-debug.log");
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
interface StreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  message?: {
    content: Array<{
      type: "text" | "tool_use" | "tool_result";
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      content?: string;
    }>;
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
  tool_use_result?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
  };
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

Defaults: model=opus, effort=xhigh, allowWrite=false, permissionMode=auto, persistSession=false, timeout=600000ms. When allowWrite=false (the default), Write/Edit/NotebookEdit are added to --disallowed-tools and the subagent is told it is in read-only-files mode.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "The task for the agent to perform",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku"],
        default: "opus",
        description: "Model to use (default: opus)",
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
          "If true, append raw stdout from each tool the subagent used to the response under `toolOutputs`. Default false — the parent receives only `toolUseSummary` counts, so the subagent absorbs bulk tokens. Each output is truncated to 8 KB.",
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
          "Raw stdout per tool invocation. Present only when the caller passed `includeToolOutputs: true`. Each output truncated to 8 KB.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            output: { type: "string" },
          },
          required: ["tool", "output"],
        },
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

interface ToolOutput {
  tool: string;
  output: string;
}

interface ProgressState {
  toolUseCount: number;
  currentToolUse: string | null;
  startTime: number;
  toolOutputs: ToolOutput[];
  toolUseCounts: Map<string, number>;
}

const TOOL_OUTPUT_MAX_BYTES = 8 * 1024;

function truncateToolOutput(output: string): string {
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= TOOL_OUTPUT_MAX_BYTES) return output;
  const head = buf.subarray(0, TOOL_OUTPUT_MAX_BYTES).toString("utf8");
  const dropped = buf.length - TOOL_OUTPUT_MAX_BYTES;
  return `${head}…[truncated ${dropped} bytes]`;
}

// Create MCP server
const server = new Server(
  {
    name: "nested-subagent",
    version: "3.0.0",
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

interface RunTaskResult {
  success: boolean;
  result?: string;
  error?: string;
  errorKind?: ErrorKind;
  toolUseCount?: number;
  duration?: number;
  tokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  toolOutputs?: ToolOutput[];
  toolUseSummary?: Array<{ tool: string; count: number }>;
  sessionId?: string;
  persisted?: boolean;
  taskId?: string;
}

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
    currentToolUse: null,
    startTime: Date.now(),
    toolOutputs: [],
    toolUseCounts: new Map<string, number>(),
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
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "tool_use" && block.name) {
                  state.toolUseCount++;
                  state.currentToolUse = block.name;
                  state.toolUseCounts.set(
                    block.name,
                    (state.toolUseCounts.get(block.name) ?? 0) + 1,
                  );

                  if (progressToken !== undefined) {
                    server.notification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: state.toolUseCount,
                        message: `Tool: ${block.name}${block.input ? ` (${JSON.stringify(block.input).slice(0, 50)}...)` : ""}`,
                      },
                    });
                  }
                } else if (block.type === "text" && block.text) {
                  if (progressToken !== undefined) {
                    server.notification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: state.toolUseCount,
                        message: `Response: ${block.text.slice(0, 100)}${block.text.length > 100 ? "..." : ""}`,
                      },
                    });
                  }
                }
              }
            }
            break;

          case "user":
            if (msg.tool_use_result) {
              const stdout = msg.tool_use_result.stdout || "";
              if (stdout && state.currentToolUse) {
                state.toolOutputs.push({
                  tool: state.currentToolUse,
                  output: stdout,
                });
              }
              if (progressToken !== undefined) {
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
          persisted,
          toolUseCount: state.toolUseCount,
          duration,
          toolUseSummary,
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

        resolve({
          success: !lastResult.is_error,
          result: lastResult.result,
          errorKind: lastResult.is_error ? "exit_nonzero" : undefined,
          toolUseCount: state.toolUseCount,
          duration,
          tokens: totalTokens,
          cacheReadTokens,
          costUsd: lastResult.total_cost_usd,
          toolOutputs: state.toolOutputs,
          toolUseSummary,
          sessionId: capturedSessionId,
          persisted,
          taskId,
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
          sessionId: capturedSessionId,
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
          persisted,
          toolUseCount: state.toolUseCount,
          duration,
          toolUseSummary,
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

  const payload = buildTaskPayload(result, Boolean(input.includeToolOutputs));
  const text = JSON.stringify(payload);

  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
    ...(payload.ok ? {} : { isError: true }),
  };
});

interface TaskStats {
  toolUseCount?: number;
  durationMs?: number;
  tokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

interface TaskPayload {
  ok: boolean;
  taskId: string;
  sessionId?: string;
  persisted?: boolean;
  result?: string;
  error?: string;
  errorKind?: ErrorKind;
  stats?: TaskStats;
  toolUseSummary?: Array<{ tool: string; count: number }>;
  toolOutputs?: Array<{ tool: string; output: string }>;
}

function buildTaskPayload(
  result: RunTaskResult,
  includeToolOutputs: boolean,
): TaskPayload {
  const stats: TaskStats = {};
  if (result.toolUseCount !== undefined) stats.toolUseCount = result.toolUseCount;
  if (result.duration !== undefined) stats.durationMs = result.duration;
  if (result.tokens !== undefined) stats.tokens = result.tokens;
  if (result.cacheReadTokens !== undefined) {
    stats.cacheReadTokens = result.cacheReadTokens;
  }
  if (result.costUsd !== undefined) stats.costUsd = result.costUsd;

  const payload: TaskPayload = {
    ok: result.success,
    taskId: result.taskId ?? "",
  };
  if (result.sessionId !== undefined) payload.sessionId = result.sessionId;
  if (result.persisted !== undefined) payload.persisted = result.persisted;
  if (Object.keys(stats).length > 0) payload.stats = stats;
  if (result.toolUseSummary && result.toolUseSummary.length > 0) {
    payload.toolUseSummary = result.toolUseSummary;
  }

  if (result.success) {
    if (result.result !== undefined) payload.result = result.result;
    if (includeToolOutputs && result.toolOutputs && result.toolOutputs.length > 0) {
      payload.toolOutputs = result.toolOutputs.map((to) => ({
        tool: to.tool,
        output: truncateToolOutput(to.output),
      }));
    }
  } else {
    if (result.error !== undefined) payload.error = result.error;
    if (result.errorKind !== undefined) payload.errorKind = result.errorKind;
  }

  return payload;
}

// Graceful shutdown - abort all active processes
process.on("SIGTERM", () => shutdownChildren(activeProcesses, "SIGTERM"));
process.on("SIGINT", () => shutdownChildren(activeProcesses, "SIGINT"));

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Nested Subagent MCP Server v2.0.0 (streaming) running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
