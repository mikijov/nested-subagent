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
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  type ActiveTaskEntry,
  type TaskInput,
  buildClaudeArgs,
  computeEffectivePersist,
  handleAbort,
  validateSessionParams,
} from "./session.js";

// Debug logging to file - use /tmp for reliable access
const LOG_FILE = "/tmp/nested-subagent-debug.log";
function log(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch {
    // Ignore logging errors
  }
}

// Initialize log file
try {
  writeFileSync(LOG_FILE, `=== Nested Subagent MCP Server Started ===\n`);
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
  description: `Launch a new agent that has access to all tools including Task. When you are searching for a keyword or file and are not confident that you will find the right match on the first try, use the Agent tool to perform the search for you. For example:

- If you are searching for a keyword like "config" or "logger", the Agent tool is appropriate
- If you want to read a specific file path, use the Read or Glob tool instead of the Agent tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
3. By default each invocation runs in a fresh, isolated session (ephemeral). To chain calls against the same underlying Claude session, pass \`persistSession: true\` (or any of \`resume\`/\`continueRecent\`/\`sessionId\`) — the result text reports the \`session_id\` so the next call can pass \`resume: "<id>"\`. Without those params the invocation remains stateless and your prompt must be self-contained.
4. The agent's outputs should generally be trusted
5. IMPORTANT: The spawned agent runs as a fresh process with its own 200k context window and CAN use the Task tool.
6. A running task can be aborted out-of-band via the sibling \`AbortTask\` tool. Pass an explicit \`taskId\` here if you intend to abort; otherwise the auto-generated id appears in the first progress notification.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 word) description of the task",
      },
      prompt: {
        type: "string",
        description: "The task for the agent to perform",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku"],
        default: "sonnet",
        description: "Model to use (default: sonnet)",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description: "Extended thinking budget for the spawned subagent (maps to --effort). Omit to use claude's default.",
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
        description: "Enable file write permissions (--dangerously-skip-permissions)",
      },
      permissionMode: {
        type: "string",
        enum: ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"],
        default: "auto",
        description: "Permission mode for the spawned subagent (default: auto). Ignored when allowWrite is true.",
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
    },
    required: ["prompt"],
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
}

// Create MCP server
const server = new Server(
  {
    name: "nested-subagent",
    version: "2.0.0",
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

/**
 * Helper to format numbers with K/M suffixes
 */
function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num.toString();
}

/**
 * Helper to format duration
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(0)}s`;
}

interface RunTaskResult {
  success: boolean;
  result?: string;
  error?: string;
  usage?: object;
  toolUseCount?: number;
  duration?: number;
  tokens?: number;
  cacheReadTokens?: number;
  toolOutputs?: ToolOutput[];
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
  const validationError = validateSessionParams(input);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const workingDir = input.workingDir ?? process.cwd();
  const timeout = input.timeout ?? 600000;
  const description = input.description;
  const persisted = computeEffectivePersist(input);

  const taskId = input.taskId ?? generateTaskId();
  if (input.taskId && activeProcesses.has(taskId)) {
    return {
      success: false,
      error: `taskId collision: ${taskId} is already active`,
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
  };

  // Reserve the entry synchronously so AbortTask calls that arrive during
  // (or even before) spawn can queue themselves against this taskId.
  activeProcesses.set(taskId, { proc: null, abortRequested: false });

  if (progressToken !== undefined) {
    const label = description ? `Task: ${description}` : "Task";
    server.notification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: 0,
        message: `${label} · taskId=${taskId}`,
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

    proc.on("close", async (code: number | null) => {
      await stderrDrained;
      log(`[${taskId}] Process closed with code: ${code}`);
      clearTimeout(timeoutId);
      activeProcesses.delete(taskId);
      const duration = Date.now() - state.startTime;
      log(`[${taskId}] Duration: ${duration}ms, timedOut: ${timedOut}, hasResult: ${!!lastResult}`);

      if (timedOut) {
        log(`[${taskId}] Resolving with timeout error`);
        resolve({
          success: false,
          error: `Task timed out after ${timeout}ms`,
          taskId,
          sessionId: capturedSessionId,
          persisted,
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
          usage: lastResult.usage,
          toolUseCount: state.toolUseCount,
          duration,
          tokens: totalTokens,
          cacheReadTokens,
          toolOutputs: state.toolOutputs,
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
          sessionId: capturedSessionId,
          persisted,
          taskId,
        });
      } else {
        resolve({
          success: false,
          error: stderr.trim() || `Process exited with code ${code}`,
          sessionId: capturedSessionId,
          persisted,
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
  log(`Model: ${input.model}, timeout: ${input.timeout}, allowWrite: ${input.allowWrite}`);

  if (!input.prompt) {
    return {
      content: [{ type: "text", text: "Error: prompt is required" }],
      isError: true,
    };
  }

  const result = await runTask(input, progressToken);
  log(`Result: success=${result.success}, error=${result.error}`);

  // Session metadata trailer — always appended when the system event yielded
  // a session_id (which it does for every spawn). Callers parse the two
  // labeled lines below to chain or correlate logs.
  const metadataLines: string[] = [];
  if (result.taskId) metadataLines.push(`task_id: ${result.taskId}`);
  if (result.sessionId) metadataLines.push(`session_id: ${result.sessionId}`);
  if (result.persisted !== undefined) {
    metadataLines.push(`persisted: ${result.persisted}`);
  }
  const metadataTrailer = metadataLines.length > 0
    ? `\n${metadataLines.join("\n")}`
    : "";

  if (result.success) {
    // Format output to match native Task tool: "Done (X tool uses · Yk tokens · Zs)"
    const toolUseText = result.toolUseCount === 1 ? '1 tool use' : `${result.toolUseCount ?? 0} tool uses`;
    const tokensText = formatNumber(result.tokens ?? 0) + ' tokens';
    const cacheText = (result.cacheReadTokens ?? 0) > 0
      ? ` · ${formatNumber(result.cacheReadTokens ?? 0)} cached`
      : '';
    const durationText = formatDuration(result.duration ?? 0);
    const summary = `Done (${toolUseText} · ${tokensText}${cacheText} · ${durationText})${metadataTrailer}`;

    // Format tool outputs for display (similar to native Task tool)
    let toolOutputsText = '';
    if (result.toolOutputs && result.toolOutputs.length > 0) {
      toolOutputsText = result.toolOutputs
        .map(to => `[${to.tool}]\n${to.output}`)
        .join('\n\n');
    }

    // Build final output: tool outputs + result + summary
    const parts: string[] = [];
    if (toolOutputsText) parts.push(toolOutputsText);
    if (result.result) parts.push(result.result);
    parts.push(summary);

    return {
      content: [
        {
          type: "text",
          text: parts.join('\n\n'),
        },
      ],
    };
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${result.error}${metadataTrailer}`,
        },
      ],
      isError: true,
    };
  }
});

// Graceful shutdown - abort all active processes
process.on("SIGTERM", () => {
  for (const entry of activeProcesses.values()) {
    entry.proc?.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const entry of activeProcesses.values()) {
      if (entry.proc && !entry.proc.killed) entry.proc.kill("SIGKILL");
    }
    process.exit(0);
  }, 5000);
});

process.on("SIGINT", () => {
  for (const entry of activeProcesses.values()) {
    entry.proc?.kill("SIGINT");
  }
  process.exit(0);
});

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
