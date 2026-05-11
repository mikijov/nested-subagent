import { describe, expect, it } from "vitest";
import {
  buildTaskPayload,
  handleAssistantContent,
  TOOL_OUTPUT_MAX_BYTES,
  type AssistantContentBlock,
  type ProgressState,
  type RunTaskResult,
} from "../src/session.js";

function makeState(): ProgressState {
  return {
    toolUseCount: 0,
    toolUseNamesById: new Map<string, string>(),
    startTime: 0,
    toolOutputs: [],
    toolUseCounts: new Map<string, number>(),
    thinkingBlockCount: 0,
    thinkingBlocks: [],
  };
}

describe("handleAssistantContent — thinking blocks", () => {
  it("captures a single thinking block", () => {
    const state = makeState();
    const { progressMessages, unknownBlockTypes } = handleAssistantContent(
      [{ type: "thinking", thinking: "abc" }],
      state,
    );
    expect(state.thinkingBlockCount).toBe(1);
    expect(state.thinkingBlocks).toEqual([{ text: "abc" }]);
    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0]).toMatch(/Thinking… \(block 1, ~3 chars\)/);
    expect(unknownBlockTypes).toEqual([]);
  });

  it("eagerly truncates oversize thinking blocks at push time", () => {
    const state = makeState();
    const oversize = "x".repeat(20 * 1024); // 20 KB ASCII = 20 KB bytes
    handleAssistantContent(
      [{ type: "thinking", thinking: oversize }],
      state,
    );
    const droppedBytes = 20 * 1024 - TOOL_OUTPUT_MAX_BYTES;
    expect(state.thinkingBlocks).toHaveLength(1);
    expect(
      state.thinkingBlocks[0].text.endsWith(`…[truncated ${droppedBytes} bytes]`),
    ).toBe(true);
  });

  it("counts a redacted_thinking block but does not surface its text", () => {
    const state = makeState();
    const { progressMessages, unknownBlockTypes } = handleAssistantContent(
      [{ type: "redacted_thinking" }],
      state,
    );
    expect(state.thinkingBlockCount).toBe(1);
    expect(state.thinkingBlocks).toEqual([]);
    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0]).toMatch(/Thinking… \(block 1, redacted\)/);
    expect(unknownBlockTypes).toEqual([]);
  });

  it("counts empty-text thinking blocks but excludes them from the surfaced array", () => {
    // Opus 4.x can emit { type: "thinking", thinking: "", signature: "…" }
    // when extended thinking is enabled but the model has no reasoning text
    // for the turn. Count it; don't surface a {text: ""} entry.
    const state = makeState();
    const { progressMessages, unknownBlockTypes } = handleAssistantContent(
      [
        { type: "thinking", thinking: "" },
        { type: "thinking" }, // missing field — same shape after `?? ""`
        { type: "thinking", thinking: "real content" },
      ],
      state,
    );
    expect(state.thinkingBlockCount).toBe(3);
    expect(state.thinkingBlocks).toEqual([{ text: "real content" }]);
    expect(progressMessages).toHaveLength(3);
    expect(progressMessages[0]).toMatch(/Thinking… \(block 1, empty\)/);
    expect(progressMessages[1]).toMatch(/Thinking… \(block 2, empty\)/);
    expect(progressMessages[2]).toMatch(/Thinking… \(block 3, ~12 chars\)/);
    expect(unknownBlockTypes).toEqual([]);
  });

  it("captures unknown block types without crashing or counting", () => {
    const state = makeState();
    const { progressMessages, unknownBlockTypes } = handleAssistantContent(
      [{ type: "server_tool_use" }],
      state,
    );
    expect(state.thinkingBlockCount).toBe(0);
    expect(state.toolUseCount).toBe(0);
    expect(state.thinkingBlocks).toEqual([]);
    expect(progressMessages).toEqual([]);
    expect(unknownBlockTypes).toEqual(["server_tool_use"]);
  });

  it("preserves order and per-type accounting in a mixed sequence", () => {
    const state = makeState();
    const blocks: AssistantContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "consider" },
      { type: "tool_use", name: "Read", input: { file_path: "/x" } },
      { type: "redacted_thinking" },
      { type: "server_tool_use" },
    ];
    const { progressMessages, unknownBlockTypes } = handleAssistantContent(
      blocks,
      state,
    );

    expect(state.toolUseCount).toBe(1);
    expect(state.toolUseCounts.get("Read")).toBe(1);
    expect(state.thinkingBlockCount).toBe(2);
    expect(state.thinkingBlocks).toEqual([{ text: "consider" }]);

    expect(progressMessages).toHaveLength(4);
    expect(progressMessages[0]).toMatch(/^Response: hello/);
    expect(progressMessages[1]).toMatch(/Thinking… \(block 1, ~8 chars\)/);
    expect(progressMessages[2]).toMatch(/^Tool: Read/);
    expect(progressMessages[3]).toMatch(/Thinking… \(block 2, redacted\)/);

    expect(unknownBlockTypes).toEqual(["server_tool_use"]);
  });
});

describe("buildTaskPayload — thinking surfacing", () => {
  const baseSuccess: RunTaskResult = {
    success: true,
    result: "ok",
    taskId: "task-test",
    toolUseCount: 0,
    duration: 100,
  };

  it("omits thinkingBlocks but includes stats.thinkingBlocks by default", () => {
    const payload = buildTaskPayload(
      {
        ...baseSuccess,
        thinkingBlockCount: 2,
        thinkingBlocks: [{ text: "a" }, { text: "b" }],
      },
      false,
      false,
    );
    expect(payload.stats?.thinkingBlocks).toBe(2);
    expect(payload.thinkingBlocks).toBeUndefined();
  });

  it("includes both stats and thinkingBlocks when includeThinking=true", () => {
    const payload = buildTaskPayload(
      {
        ...baseSuccess,
        thinkingBlockCount: 2,
        thinkingBlocks: [{ text: "a" }, { text: "b" }],
      },
      false,
      true,
    );
    expect(payload.stats?.thinkingBlocks).toBe(2);
    expect(payload.thinkingBlocks).toEqual([{ text: "a" }, { text: "b" }]);
  });

  it("passes through pre-truncated thinking entries unchanged", () => {
    // Truncation now happens eagerly in handleAssistantContent. buildTaskPayload
    // is a pass-through; the dedicated truncation test lives in the
    // handleAssistantContent block.
    const text = "already-bounded";
    const payload = buildTaskPayload(
      {
        ...baseSuccess,
        thinkingBlockCount: 1,
        thinkingBlocks: [{ text }],
      },
      false,
      true,
    );
    expect(payload.thinkingBlocks).toEqual([{ text }]);
  });

  it("surfaces thinkingBlocks even on a failed result", () => {
    const payload = buildTaskPayload(
      {
        success: false,
        error: "boom",
        errorKind: "exit_nonzero",
        taskId: "task-test",
        thinkingBlockCount: 1,
        thinkingBlocks: [{ text: "y" }],
      },
      false,
      true,
    );
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("boom");
    expect(payload.errorKind).toBe("exit_nonzero");
    expect(payload.stats?.thinkingBlocks).toBe(1);
    expect(payload.thinkingBlocks).toEqual([{ text: "y" }]);
    expect(payload.result).toBeUndefined();
  });

  it("excludes redacted blocks from thinkingBlocks while counting them", () => {
    // Mirrors the runtime: handleAssistantContent does not push redacted
    // blocks into state.thinkingBlocks, so result.thinkingBlocks is shorter
    // than result.thinkingBlockCount when redactions occurred.
    const payload = buildTaskPayload(
      {
        ...baseSuccess,
        thinkingBlockCount: 3,
        thinkingBlocks: [{ text: "a" }],
      },
      false,
      true,
    );
    expect(payload.stats?.thinkingBlocks).toBe(3);
    expect(payload.thinkingBlocks).toEqual([{ text: "a" }]);
  });

  it("omits stats.thinkingBlocks when count is zero", () => {
    const payload = buildTaskPayload(
      { ...baseSuccess, thinkingBlockCount: 0, thinkingBlocks: [] },
      false,
      true,
    );
    expect(payload.stats?.thinkingBlocks).toBeUndefined();
    expect(payload.thinkingBlocks).toBeUndefined();
  });
});
