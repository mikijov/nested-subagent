import { describe, expect, it } from "vitest";
import { buildClaudeArgs, type TaskInput } from "../src/session.js";

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx === args.length - 1) return undefined;
  return args[idx + 1];
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
    expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(true);
    // --allowed-tools is followed by each tool as a separate arg
    const allowedIdx = args.indexOf("--allowed-tools");
    expect(args.slice(allowedIdx + 1, allowedIdx + 3)).toEqual(["Bash", "Read"]);
    expect(flagValue(args, "--disallowed-tools")).toBe("WebFetch");
    const addDirIdx = args.indexOf("--add-dir");
    expect(args.slice(addDirIdx + 1, addDirIdx + 3)).toEqual(["/tmp/a", "/tmp/b"]);
    expect(flagValue(args, "--max-budget-usd")).toBe("0.5");
    expect(flagValue(args, "--system-prompt")).toBe("be brief");
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

  it("permissionMode: defaults to --permission-mode auto when neither permissionMode nor allowWrite is set", () => {
    const args = buildClaudeArgs(base);
    expect(flagValue(args, "--permission-mode")).toBe("auto");
    expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(false);
  });

  it("permissionMode: allowWrite suppresses --permission-mode default (mutual exclusivity preserved)", () => {
    const args = buildClaudeArgs({ ...base, allowWrite: true });
    expect(hasFlag(args, "--permission-mode")).toBe(false);
    expect(hasFlag(args, "--dangerously-skip-permissions")).toBe(true);
  });
});
