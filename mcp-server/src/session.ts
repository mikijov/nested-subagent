/**
 * Pure helpers for the Task / AbortTask tools.
 *
 * Kept separate from index.ts so unit tests can import them without booting
 * the MCP stdio server. tsdown inlines this module into the bundled dist.
 */

export interface TaskInput {
  description?: string;
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
}

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

  if (allowWrite) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permissionMode ?? "auto");
  }

  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  if (appendSystemPrompt)
    args.push("--append-system-prompt", appendSystemPrompt);

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowed-tools", ...allowedTools);
  }
  if (disallowedTools && disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...disallowedTools);
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
