import { describe, expect, it } from "vitest";
import {
  handleAssistantContent,
  handleUserContent,
  type AssistantContentBlock,
  type ProgressState,
  type UserMessageEnvelope,
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

describe("handleUserContent — tool_use_id attribution", () => {
  it("attributes a single tool_result to the matching tool_use", () => {
    const state = makeState();
    handleAssistantContent(
      [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "/a" } }],
      state,
    );
    const message: UserMessageEnvelope = {
      content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }],
    };
    handleUserContent(message, { stdout: "read-out", stderr: "" }, state);
    expect(state.toolOutputs).toEqual([{ tool: "Read", output: "read-out" }]);
  });

  it("labels parallel tool_uses correctly when results arrive in order", () => {
    const state = makeState();
    const blocks: AssistantContentBlock[] = [
      { type: "tool_use", id: "u1", name: "Read", input: { file_path: "/a" } },
      { type: "tool_use", id: "u2", name: "Bash", input: { command: "ls" } },
    ];
    handleAssistantContent(blocks, state);
    handleUserContent(
      { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] },
      { stdout: "read-out", stderr: "" },
      state,
    );
    handleUserContent(
      { content: [{ type: "tool_result", tool_use_id: "u2", content: "ok" }] },
      { stdout: "bash-out", stderr: "" },
      state,
    );
    expect(state.toolOutputs).toEqual([
      { tool: "Read", output: "read-out" },
      { tool: "Bash", output: "bash-out" },
    ]);
  });

  it("labels parallel tool_uses correctly when results arrive reversed", () => {
    const state = makeState();
    const blocks: AssistantContentBlock[] = [
      { type: "tool_use", id: "u1", name: "Read", input: { file_path: "/a" } },
      { type: "tool_use", id: "u2", name: "Bash", input: { command: "ls" } },
    ];
    handleAssistantContent(blocks, state);
    // Bash result first, then Read result.
    handleUserContent(
      { content: [{ type: "tool_result", tool_use_id: "u2", content: "ok" }] },
      { stdout: "bash-out", stderr: "" },
      state,
    );
    handleUserContent(
      { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] },
      { stdout: "read-out", stderr: "" },
      state,
    );
    expect(state.toolOutputs).toEqual([
      { tool: "Bash", output: "bash-out" },
      { tool: "Read", output: "read-out" },
    ]);
  });

  it("labels an unknown tool_use_id as (unknown) rather than mis-attributing", () => {
    const state = makeState();
    handleAssistantContent(
      [{ type: "tool_use", id: "u1", name: "Read" }],
      state,
    );
    handleUserContent(
      { content: [{ type: "tool_result", tool_use_id: "ghost", content: "ok" }] },
      { stdout: "mystery-out", stderr: "" },
      state,
    );
    expect(state.toolOutputs).toEqual([
      { tool: "(unknown)", output: "mystery-out" },
    ]);
  });

  it("skips the push when tool_use_result is a string (error path)", () => {
    const state = makeState();
    handleAssistantContent(
      [{ type: "tool_use", id: "u1", name: "Bash" }],
      state,
    );
    expect(() =>
      handleUserContent(
        { content: [{ type: "tool_result", tool_use_id: "u1", is_error: true }] },
        "Error: permission denied",
        state,
      ),
    ).not.toThrow();
    expect(state.toolOutputs).toEqual([]);
  });
});
