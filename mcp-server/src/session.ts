/**
 * Pure helpers for the Task / AbortTask tools.
 *
 * Kept separate from index.ts so unit tests can import them without booting
 * the MCP stdio server. tsdown inlines this module into the bundled dist.
 */

export interface TaskInput {
  prompt: string;
  model?: "sonnet" | "opus" | "haiku";
  workingDir?: string;
  timeout?: number;
  allowWrite?: boolean;
  permissionMode?:
    | "acceptEdits"
    | "auto"
    | "bypassPermissions"
    | "default"
    | "dontAsk"
    | "plan";
  dangerouslySkipPermissions?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  addDirs?: string[];
  // Session lifecycle
  sessionId?: string;
  resume?: string;
  continueRecent?: boolean;
  forkSession?: boolean;
  persistSession?: boolean;
  // Out-of-band abort handle
  taskId?: string;
  // Response shape
  includeToolOutputs?: boolean;
  includeThinking?: boolean;
}

export type ErrorKind =
  | "timeout"
  | "spawn_failed"
  | "validation"
  | "exit_nonzero"
  | "aborted";

export interface AbortableProc {
  kill(signal?: NodeJS.Signals | number): boolean;
  exitCode: number | null;
  killed: boolean;
}

export interface ActiveTaskEntry {
  proc: AbortableProc | null;
  abortRequested: boolean;
  abortSignal?: NodeJS.Signals;
}

export type AbortOutcome =
  | "aborted"
  | "pending"
  | "not_found"
  | "already_exited";

export function computeEffectivePersist(input: TaskInput): boolean {
  if (input.persistSession !== undefined) return input.persistSession;
  return Boolean(
    input.resume ||
      input.continueRecent ||
      input.forkSession ||
      input.sessionId,
  );
}

/**
 * Returns an error message string if the combination of session params is
 * invalid, otherwise null. Caller should reject the request and surface the
 * message verbatim.
 */
export function validateSessionParams(input: TaskInput): string | null {
  if (input.resume && input.continueRecent) {
    return "resume and continueRecent are mutually exclusive";
  }
  const hasResumeSource = Boolean(input.resume || input.continueRecent);
  if (
    input.persistSession === false &&
    (hasResumeSource || input.forkSession || input.sessionId)
  ) {
    return "persistSession=false conflicts with session lifecycle params (resume/continueRecent/sessionId/forkSession require a persisted session)";
  }
  if (input.forkSession && !hasResumeSource) {
    return "forkSession requires resume or continueRecent";
  }
  if (input.sessionId && hasResumeSource && !input.forkSession) {
    return "sessionId combined with resume/continueRecent requires forkSession (CLI requirement)";
  }
  return null;
}

/**
 * Returns an error message if dangerouslySkipPermissions is combined with
 * permissionMode (the former disables all permission machinery, making the
 * latter meaningless), otherwise null.
 */
export function validatePermissionParams(input: TaskInput): string | null {
  if (input.dangerouslySkipPermissions && input.permissionMode !== undefined) {
    return "dangerouslySkipPermissions cannot be combined with permissionMode (the former disables all permission prompts, making the latter ineffective)";
  }
  return null;
}

export const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;

export const READ_ONLY_FILES_PROMPT =
  "You are running with file modification disabled. You may read files and run analysis commands, but you must not create, modify, or delete files using Write, Edit, or NotebookEdit. Bash redirects, sed -i, tee, and similar shell-based file modification are also off-limits even though they are not hard-blocked.";

/**
 * Build the full claude-CLI argv (excluding the `claude` exe itself) for a
 * Task input. Pure: no env reads, no spawn. The plugin-root propagation is
 * applied here too so the bundled bin can be tested end-to-end.
 */
export function buildClaudeArgs(
  input: TaskInput,
  env: { CLAUDE_PLUGIN_ROOT?: string } = {},
): string[] {
  const {
    prompt,
    model = "opus",
    allowWrite = false,
    permissionMode,
    dangerouslySkipPermissions = false,
    effort = "xhigh",
    systemPrompt,
    appendSystemPrompt,
    allowedTools,
    disallowedTools,
    maxBudgetUsd,
    addDirs,
    sessionId,
    resume,
    continueRecent,
    forkSession,
  } = input;

  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
  ];

  args.push("--effort", effort);

  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permissionMode ?? "auto");
  }

  if (systemPrompt) args.push("--system-prompt", systemPrompt);

  const mergedAppendSP = [
    appendSystemPrompt,
    allowWrite ? null : READ_ONLY_FILES_PROMPT,
  ]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");
  if (mergedAppendSP) args.push("--append-system-prompt", mergedAppendSP);

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowed-tools", ...allowedTools);
  }

  const effectiveDisallowed = new Set<string>(disallowedTools ?? []);
  if (!allowWrite) for (const t of WRITE_TOOLS) effectiveDisallowed.add(t);
  if (effectiveDisallowed.size > 0) {
    args.push("--disallowed-tools", ...effectiveDisallowed);
  }

  if (maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }

  if (addDirs && addDirs.length > 0) {
    args.push("--add-dir", ...addDirs);
  }

  // Session lifecycle. Order mirrors the CLI: source first, then ID, then fork.
  if (resume) {
    args.push("--resume", resume);
  } else if (continueRecent) {
    args.push("--continue");
  }
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  if (forkSession) {
    args.push("--fork-session");
  }

  if (!computeEffectivePersist(input)) {
    args.push("--no-session-persistence");
  }

  if (env.CLAUDE_PLUGIN_ROOT) {
    args.push("--plugin-dir", env.CLAUDE_PLUGIN_ROOT);
  }

  return args;
}

/**
 * Pure handler for the AbortTask tool. Mutates the given entry in place if
 * an abort is queued or delivered; returns the outcome the caller should
 * surface to the MCP client.
 */
export function handleAbort(
  map: Map<string, ActiveTaskEntry>,
  taskId: string,
  signal: NodeJS.Signals = "SIGTERM",
): AbortOutcome {
  const entry = map.get(taskId);
  if (!entry) return "not_found";
  if (entry.proc === null) {
    entry.abortRequested = true;
    entry.abortSignal = signal;
    return "pending";
  }
  if (entry.proc.exitCode !== null || entry.proc.killed) {
    return "already_exited";
  }
  entry.proc.kill(signal);
  return "aborted";
}

export function shutdownChildren(
  map: Map<string, ActiveTaskEntry>,
  signal: "SIGTERM" | "SIGINT",
  graceMs = 5000,
): void {
  for (const entry of map.values()) {
    entry.proc?.kill(signal);
  }
  setTimeout(() => {
    for (const entry of map.values()) {
      if (entry.proc && !entry.proc.killed) entry.proc.kill("SIGKILL");
    }
    process.exit(0);
  }, graceMs);
}

// ---------------------------------------------------------------------------
// Stream parsing / response shaping
// ---------------------------------------------------------------------------

export interface ToolOutput {
  tool: string;
  output: string;
}

export interface ThinkingBlock {
  text: string;
}

export interface ProgressState {
  toolUseCount: number;
  toolUseNamesById: Map<string, string>;
  startTime: number;
  toolOutputs: ToolOutput[];
  toolUseCounts: Map<string, number>;
  thinkingBlockCount: number;
  thinkingBlocks: ThinkingBlock[];
}

export interface RunTaskResult {
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
  thinkingBlockCount?: number;
  thinkingBlocks?: ThinkingBlock[];
  sessionId?: string;
  persisted?: boolean;
  taskId?: string;
}

export interface TaskStats {
  toolUseCount?: number;
  durationMs?: number;
  tokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  thinkingBlocks?: number;
}

export interface TaskPayload {
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
  thinkingBlocks?: ThinkingBlock[];
}

export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024;

/**
 * Truncate a string so its UTF-8 byte length does not exceed `maxBytes`.
 * Decoding the head buffer with `Buffer.toString("utf8")` replaces any
 * truncated mid-multibyte-character bytes with U+FFFD, so the marker length
 * accounts for that.
 */
export function truncateUtf8(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return input;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  const dropped = buf.length - maxBytes;
  return `${head}…[truncated ${dropped} bytes]`;
}

export interface AssistantContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string;
  thinking?: string;
}

export interface ToolResultBlock {
  type: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface UserMessageEnvelope {
  content: ToolResultBlock[];
}

export type ToolUseResultSidecar =
  | string
  | { stdout?: string; stderr?: string; interrupted?: boolean }
  | undefined;

/**
 * Pure parser for a single assistant message's content array. Mutates
 * `state` (tool counters, thinking counters, tool/thinking accumulators) and
 * returns the progress messages the caller should emit and any unknown block
 * types the caller should log. Side-effect free beyond `state`.
 */
export function handleAssistantContent(
  content: AssistantContentBlock[],
  state: ProgressState,
): { progressMessages: string[]; unknownBlockTypes: string[] } {
  const progressMessages: string[] = [];
  const unknownBlockTypes: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "tool_use":
        if (block.name) {
          state.toolUseCount++;
          if (block.id) {
            state.toolUseNamesById.set(block.id, block.name);
          }
          state.toolUseCounts.set(
            block.name,
            (state.toolUseCounts.get(block.name) ?? 0) + 1,
          );
          progressMessages.push(
            `Tool: ${block.name}${block.input ? ` (${JSON.stringify(block.input).slice(0, 50)}...)` : ""}`,
          );
        }
        break;
      case "text":
        if (block.text) {
          progressMessages.push(
            `Response: ${block.text.slice(0, 100)}${block.text.length > 100 ? "..." : ""}`,
          );
        }
        break;
      case "thinking": {
        state.thinkingBlockCount++;
        // Truncate eagerly to bound the in-memory accumulator on verbose
        // extended-thinking runs. Single source of truth — buildTaskPayload
        // passes through, so a re-truncation pass can't clobber the
        // dropped-byte marker.
        const text = truncateUtf8(
          block.thinking ?? "",
          TOOL_OUTPUT_MAX_BYTES,
        );
        // Opus 4.x sometimes emits a signed-but-empty thinking block when
        // extended thinking is enabled but the model has no reasoning text
        // to surface for that turn. The signature satisfies API continuity;
        // the empty string is noise. Count it (so stats stay honest) but
        // skip it from the surfaced array — same pattern as redacted_thinking.
        if (text.length > 0) {
          state.thinkingBlocks.push({ text });
          progressMessages.push(
            `Thinking… (block ${state.thinkingBlockCount}, ~${text.length} chars)`,
          );
        } else {
          progressMessages.push(
            `Thinking… (block ${state.thinkingBlockCount}, empty)`,
          );
        }
        break;
      }
      case "redacted_thinking":
        // Encrypted blob — counted but never surfaced as text, since the
        // isolated child process can't decrypt it for the parent.
        state.thinkingBlockCount++;
        progressMessages.push(
          `Thinking… (block ${state.thinkingBlockCount}, redacted)`,
        );
        break;
      default:
        unknownBlockTypes.push(block.type);
    }
  }
  return { progressMessages, unknownBlockTypes };
}

/**
 * Pure parser for a single user-event message: correlates each tool_result
 * block to the tool name recorded under its tool_use_id by an earlier
 * handleAssistantContent pass, and pushes the sidecar stdout into
 * state.toolOutputs. Side-effect free beyond `state`.
 *
 * Gating: only the object-form sidecar with non-empty stdout produces a push.
 * String form (error/permission-denied path), missing sidecar, and empty
 * stdout are all skipped — uniformly for known and unknown ids — so labelling
 * errors never create ghost rows. Unknown ids that *do* clear the gate are
 * labelled "(unknown)" rather than mis-attributed.
 */
export function handleUserContent(
  message: UserMessageEnvelope | undefined,
  toolUseResult: ToolUseResultSidecar,
  state: ProgressState,
): void {
  if (!message?.content) return;
  const stdout =
    typeof toolUseResult === "object" && toolUseResult !== null
      ? toolUseResult.stdout ?? ""
      : "";
  if (!stdout) return;
  for (const block of message.content) {
    if (block.type !== "tool_result") continue;
    const id = block.tool_use_id;
    const name =
      id !== undefined ? state.toolUseNamesById.get(id) : undefined;
    state.toolOutputs.push({
      tool: name ?? "(unknown)",
      output: stdout,
    });
  }
}

/**
 * Project a RunTaskResult into the wire-shape returned by the MCP tool. Pure:
 * deterministic given inputs.
 */
export function buildTaskPayload(
  result: RunTaskResult,
  includeToolOutputs: boolean,
  includeThinking: boolean,
): TaskPayload {
  const stats: TaskStats = {};
  if (result.toolUseCount !== undefined) stats.toolUseCount = result.toolUseCount;
  if (result.duration !== undefined) stats.durationMs = result.duration;
  if (result.tokens !== undefined) stats.tokens = result.tokens;
  if (result.cacheReadTokens !== undefined) {
    stats.cacheReadTokens = result.cacheReadTokens;
  }
  if (result.costUsd !== undefined) stats.costUsd = result.costUsd;
  if (result.thinkingBlockCount !== undefined && result.thinkingBlockCount > 0) {
    stats.thinkingBlocks = result.thinkingBlockCount;
  }

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
        output: truncateUtf8(to.output, TOOL_OUTPUT_MAX_BYTES),
      }));
    }
  } else {
    if (result.error !== undefined) payload.error = result.error;
    if (result.errorKind !== undefined) payload.errorKind = result.errorKind;
  }

  if (
    includeThinking &&
    result.thinkingBlocks &&
    result.thinkingBlocks.length > 0
  ) {
    // Already truncated eagerly in handleAssistantContent — pass through.
    payload.thinkingBlocks = result.thinkingBlocks;
  }

  return payload;
}
