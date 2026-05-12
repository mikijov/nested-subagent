import { describe, expect, it } from "vitest";
import {
  ASK_OPERATOR_PROMPT,
  ASK_OPERATOR_SENTINEL_OPEN,
  buildClaudeArgs,
  READ_ONLY_FILES_PROMPT,
  validatePermissionParams,
  type TaskInput,
} from "../src/session.js";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

function flagAllValues(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx < 0) return [];
  const values: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    values.push(args[i]);
  }
  return values;
}

describe("buildClaudeArgs", () => {
  const base: TaskInput = { prompt: "hello" };

  it("default: ephemeral session (--no-session-persistence, no resume flags)", () => {
    const args = buildClaudeArgs(base);
    expect(hasFlag(args, "--no-session-persistence")).toBe(true);
    expect(hasFlag(args, "--resume")).toBe(false);
    expect(hasFlag(args, "--continue")).toBe(false);
    expect(hasFlag(args, "--session-id")).toBe(false);
    expect(hasFlag(args, "--fork-session")).toBe(false);
  });

  it("includes the prompt and the standard stream-json scaffolding", () => {
    const args = buildClaudeArgs({ prompt: "do thing" });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("do thing");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(flagValue(args, "--model")).toBe("opus");
  });

  it("resume only: --resume <id>, no --no-session-persistence", () => {
    const args = buildClaudeArgs({ ...base, resume: "u-1" });
    expect(flagValue(args, "--resume")).toBe("u-1");
    expect(hasFlag(args, "--no-session-persistence")).toBe(false);
    expect(hasFlag(args, "--continue")).toBe(false);
    expect(hasFlag(args, "--session-id")).toBe(false);
    expect(hasFlag(args, "--fork-session")).toBe(false);
  });

  it("continueRecent only: --continue, no --no-session-persistence", () => {
    const args = buildClaudeArgs({ ...base, continueRecent: true });
    expect(hasFlag(args, "--continue")).toBe(true);
    expect(hasFlag(args, "--no-session-persistence")).toBe(false);
    expect(hasFlag(args, "--resume")).toBe(false);
  });

  it("sessionId alone: --session-id <id>, no fork, no --no-session-persistence", () => {
    const args = buildClaudeArgs({ ...base, sessionId: "u-2" });
    expect(flagValue(args, "--session-id")).toBe("u-2");
    expect(hasFlag(args, "--fork-session")).toBe(false);
    expect(hasFlag(args, "--no-session-persistence")).toBe(false);
  });

  it("resume + sessionId + forkSession: all three flags present", () => {
    const args = buildClaudeArgs({
      ...base,
      resume: "u-3",
      sessionId: "u-4",
      forkSession: true,
    });
    expect(flagValue(args, "--resume")).toBe("u-3");
    expect(flagValue(args, "--session-id")).toBe("u-4");
    expect(hasFlag(args, "--fork-session")).toBe(true);
    expect(hasFlag(args, "--no-session-persistence")).toBe(false);
  });

  it("continueRecent + sessionId + forkSession: all three flags present", () => {
    const args = buildClaudeArgs({
      ...base,
      continueRecent: true,
      sessionId: "u-5",
      forkSession: true,
    });
    expect(hasFlag(args, "--continue")).toBe(true);
    expect(flagValue(args, "--session-id")).toBe("u-5");
    expect(hasFlag(args, "--fork-session")).toBe(true);
  });

  it("resume + forkSession (no sessionId): --resume and --fork-session, no --session-id", () => {
    const args = buildClaudeArgs({
      ...base,
      resume: "u-6",
      forkSession: true,
    });
    expect(flagValue(args, "--resume")).toBe("u-6");
    expect(hasFlag(args, "--fork-session")).toBe(true);
    expect(hasFlag(args, "--session-id")).toBe(false);
    expect(hasFlag(args, "--no-session-persistence")).toBe(false);
  });

  it("persistSession: true alone suppresses --no-session-persistence without adding resume flags", () => {
    const args = buildClaudeArgs({ ...base, persistSession: true });
    expect(hasFlag(args, "--no-session-persistence")).toBe(false);
    expect(hasFlag(args, "--resume")).toBe(false);
    expect(hasFlag(args, "--continue")).toBe(false);
  });

  it("persistSession: false (explicit) keeps --no-session-persistence", () => {
    const args = buildClaudeArgs({ ...base, persistSession: false });
    expect(hasFlag(args, "--no-session-persistence")).toBe(true);
  });

  it("preserves existing flags (permission, tools, addDirs) across cases", () => {
    const args = buildClaudeArgs({
      prompt: "x",
      allowWrite: true,
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["WebFetch"],
      addDirs: ["/tmp/a", "/tmp/b"],
      maxBudgetUsd: 0.5,
      systemPrompt: "be brief",
      appendSystemPrompt: "also concise",
      resume: "u-7",
    });
    // allowWrite=true no longer triggers --dangerously-skip-permissions;
    // permissionMode default (auto) is used.
    expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(false);
    expect(flagValue(args, "--permission-mode")).toBe("auto");
    // --allowed-tools is followed by each tool as a separate arg
    expect(flagAllValues(args, "--allowed-tools")).toEqual(["Bash", "Read"]);
    // allowWrite=true means no Write/Edit/NotebookEdit appended
    expect(flagAllValues(args, "--disallowed-tools")).toEqual(["WebFetch"]);
    expect(flagAllValues(args, "--add-dir")).toEqual(["/tmp/a", "/tmp/b"]);
    expect(flagValue(args, "--max-budget-usd")).toBe("0.5");
    expect(flagValue(args, "--system-prompt")).toBe("be brief");
    // allowWrite=true means the read-only hint is NOT appended
    expect(flagValue(args, "--append-system-prompt")).toBe("also concise");
    expect(flagValue(args, "--resume")).toBe("u-7");
  });

  it("permissionMode takes effect when allowWrite is false", () => {
    const args = buildClaudeArgs({
      ...base,
      allowWrite: false,
      permissionMode: "acceptEdits",
    });
    expect(flagValue(args, "--permission-mode")).toBe("acceptEdits");
    expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(false);
    // allowWrite=false adds the write-tool denylist and the read-only hint
    expect(flagAllValues(args, "--disallowed-tools")).toEqual([
      "Write",
      "Edit",
      "NotebookEdit",
    ]);
    expect(flagValue(args, "--append-system-prompt")).toBe(
      READ_ONLY_FILES_PROMPT,
    );
  });

  it("propagates CLAUDE_PLUGIN_ROOT via --plugin-dir when present", () => {
    const args = buildClaudeArgs(base, {
      CLAUDE_PLUGIN_ROOT: "/path/to/plugin",
    });
    expect(flagValue(args, "--plugin-dir")).toBe("/path/to/plugin");
  });

  it("omits --plugin-dir when CLAUDE_PLUGIN_ROOT is missing", () => {
    const args = buildClaudeArgs(base, {});
    expect(hasFlag(args, "--plugin-dir")).toBe(false);
  });

  it("effort: --effort <level> is emitted when provided", () => {
    const args = buildClaudeArgs({ ...base, effort: "high" });
    expect(flagValue(args, "--effort")).toBe("high");
  });

  it("effort: --effort defaults to xhigh when unset", () => {
    const args = buildClaudeArgs(base);
    expect(flagValue(args, "--effort")).toBe("xhigh");
  });

  it("permissionMode: defaults to --permission-mode auto when neither permissionMode nor dangerouslySkipPermissions is set", () => {
    const args = buildClaudeArgs(base);
    expect(flagValue(args, "--permission-mode")).toBe("auto");
    expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(false);
  });

  describe("allowWrite (file-modification gate)", () => {
    it("defaults to false: appends Write/Edit/NotebookEdit to --disallowed-tools", () => {
      const args = buildClaudeArgs(base);
      expect(flagAllValues(args, "--disallowed-tools")).toEqual([
        "Write",
        "Edit",
        "NotebookEdit",
      ]);
    });

    it("defaults to false: appends the read-only-files system prompt", () => {
      const args = buildClaudeArgs(base);
      expect(flagValue(args, "--append-system-prompt")).toBe(
        READ_ONLY_FILES_PROMPT,
      );
    });

    it("false + user-provided disallowedTools merges (deduped) with write tools", () => {
      const args = buildClaudeArgs({
        ...base,
        disallowedTools: ["WebFetch", "Edit"], // Edit duplicates; should appear once
      });
      const disallowed = flagAllValues(args, "--disallowed-tools");
      expect(disallowed).toEqual(["WebFetch", "Edit", "Write", "NotebookEdit"]);
    });

    it("false + user-provided appendSystemPrompt joins with the read-only hint by \\n\\n", () => {
      const args = buildClaudeArgs({
        ...base,
        appendSystemPrompt: "extra",
      });
      expect(flagValue(args, "--append-system-prompt")).toBe(
        `extra\n\n${READ_ONLY_FILES_PROMPT}`,
      );
    });

    it("true: does NOT add write tools to --disallowed-tools", () => {
      const args = buildClaudeArgs({ ...base, allowWrite: true });
      // No --disallowed-tools flag at all when nothing is disallowed
      expect(hasFlag(args, "--disallowed-tools")).toBe(false);
    });

    it("true: does NOT add the read-only-files system prompt", () => {
      const args = buildClaudeArgs({ ...base, allowWrite: true });
      expect(hasFlag(args, "--append-system-prompt")).toBe(false);
    });

    it("true: still emits --permission-mode (no suppression)", () => {
      const args = buildClaudeArgs({ ...base, allowWrite: true });
      expect(flagValue(args, "--permission-mode")).toBe("auto");
      expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(false);
    });
  });

  describe("askOperator", () => {
    it("true: appends the operator-escape prompt to --append-system-prompt", () => {
      const args = buildClaudeArgs({
        ...base,
        askOperator: true,
        allowWrite: true,
      });
      const sp = flagValue(args, "--append-system-prompt") ?? "";
      expect(sp).toContain(ASK_OPERATOR_SENTINEL_OPEN);
      expect(sp).toBe(ASK_OPERATOR_PROMPT);
    });

    it("true + allowWrite=false: read-only first, ask-operator last, joined by \\n\\n", () => {
      const args = buildClaudeArgs({ ...base, askOperator: true });
      const sp = flagValue(args, "--append-system-prompt") ?? "";
      expect(sp).toBe(`${READ_ONLY_FILES_PROMPT}\n\n${ASK_OPERATOR_PROMPT}`);
    });

    it("true + caller appendSystemPrompt: order is caller → read-only → ask-operator", () => {
      const args = buildClaudeArgs({
        ...base,
        askOperator: true,
        appendSystemPrompt: "caller-note",
      });
      const sp = flagValue(args, "--append-system-prompt") ?? "";
      expect(sp).toBe(
        `caller-note\n\n${READ_ONLY_FILES_PROMPT}\n\n${ASK_OPERATOR_PROMPT}`,
      );
    });

    it("false (default): does NOT append the operator prompt", () => {
      const args = buildClaudeArgs({ ...base, allowWrite: true });
      expect(hasFlag(args, "--append-system-prompt")).toBe(false);
    });

    it("true: suppresses --no-session-persistence (auto-persist)", () => {
      const args = buildClaudeArgs({ ...base, askOperator: true });
      expect(hasFlag(args, "--no-session-persistence")).toBe(false);
    });

    it("true + explicit persistSession=true: still no --no-session-persistence", () => {
      const args = buildClaudeArgs({
        ...base,
        askOperator: true,
        persistSession: true,
      });
      expect(hasFlag(args, "--no-session-persistence")).toBe(false);
    });
  });

  describe("dangerouslySkipPermissions", () => {
    it("true: emits --dangerously-skip-permissions and suppresses --permission-mode", () => {
      const args = buildClaudeArgs({
        ...base,
        dangerouslySkipPermissions: true,
      });
      expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(true);
      expect(hasFlag(args, "--permission-mode")).toBe(false);
    });

    it("true + allowWrite=false still emits the write-tool denylist (independent of permission flag)", () => {
      const args = buildClaudeArgs({
        ...base,
        dangerouslySkipPermissions: true,
        allowWrite: false,
      });
      expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(true);
      expect(flagAllValues(args, "--disallowed-tools")).toEqual([
        "Write",
        "Edit",
        "NotebookEdit",
      ]);
      expect(flagValue(args, "--append-system-prompt")).toBe(
        READ_ONLY_FILES_PROMPT,
      );
    });

    it("false (default): emits --permission-mode auto, no --dangerously-skip-permissions", () => {
      const args = buildClaudeArgs(base);
      expect(flagValue(args, "--permission-mode")).toBe("auto");
      expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(false);
    });
  });
});

describe("validatePermissionParams", () => {
  it("rejects dangerouslySkipPermissions=true combined with permissionMode", () => {
    const err = validatePermissionParams({
      prompt: "x",
      dangerouslySkipPermissions: true,
      permissionMode: "auto",
    });
    expect(err).toMatch(/dangerouslySkipPermissions cannot be combined/);
  });

  it("accepts dangerouslySkipPermissions alone", () => {
    expect(
      validatePermissionParams({
        prompt: "x",
        dangerouslySkipPermissions: true,
      }),
    ).toBeNull();
  });

  it("accepts permissionMode alone", () => {
    expect(
      validatePermissionParams({ prompt: "x", permissionMode: "acceptEdits" }),
    ).toBeNull();
  });

  it("accepts allowWrite alone (with no permissionMode or dangerouslySkipPermissions)", () => {
    expect(
      validatePermissionParams({ prompt: "x", allowWrite: true }),
    ).toBeNull();
  });

  it("accepts dangerouslySkipPermissions + allowWrite=false (denylist + bypass is legal)", () => {
    expect(
      validatePermissionParams({
        prompt: "x",
        dangerouslySkipPermissions: true,
        allowWrite: false,
      }),
    ).toBeNull();
  });

  it("accepts an empty input", () => {
    expect(validatePermissionParams({ prompt: "x" })).toBeNull();
  });
});
