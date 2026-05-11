import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAbort,
  shutdownChildren,
  type AbortableProc,
  type ActiveTaskEntry,
} from "../src/session.js";

function makeProc(opts: {
  exitCode?: number | null;
  killed?: boolean;
} = {}): AbortableProc & { kill: ReturnType<typeof vi.fn> } {
  return {
    kill: vi.fn().mockReturnValue(true),
    exitCode: opts.exitCode ?? null,
    killed: opts.killed ?? false,
  };
}

describe("handleAbort", () => {
  it("returns 'not_found' when taskId is unknown", () => {
    const map = new Map<string, ActiveTaskEntry>();
    expect(handleAbort(map, "missing")).toBe("not_found");
  });

  it("returns 'pending' and queues the signal when proc is still null", () => {
    const map = new Map<string, ActiveTaskEntry>();
    const entry: ActiveTaskEntry = { proc: null, abortRequested: false };
    map.set("t-1", entry);
    expect(handleAbort(map, "t-1", "SIGKILL")).toBe("pending");
    expect(entry.abortRequested).toBe(true);
    expect(entry.abortSignal).toBe("SIGKILL");
  });

  it("returns 'aborted' and delivers the signal when proc is live", () => {
    const proc = makeProc();
    const map = new Map<string, ActiveTaskEntry>();
    map.set("t-2", { proc, abortRequested: false });
    expect(handleAbort(map, "t-2", "SIGTERM")).toBe("aborted");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("defaults to SIGTERM when no signal is provided", () => {
    const proc = makeProc();
    const map = new Map<string, ActiveTaskEntry>();
    map.set("t-3", { proc, abortRequested: false });
    expect(handleAbort(map, "t-3")).toBe("aborted");
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("returns 'already_exited' when proc has a non-null exitCode", () => {
    const proc = makeProc({ exitCode: 0 });
    const map = new Map<string, ActiveTaskEntry>();
    map.set("t-4", { proc, abortRequested: false });
    expect(handleAbort(map, "t-4")).toBe("already_exited");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("returns 'already_exited' when proc.killed is true", () => {
    const proc = makeProc({ killed: true });
    const map = new Map<string, ActiveTaskEntry>();
    map.set("t-5", { proc, abortRequested: false });
    expect(handleAbort(map, "t-5")).toBe("already_exited");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("delivering a queued abort: pending then proc attached", () => {
    // Simulates the runTask placeholder pattern: caller calls AbortTask first,
    // then runTask attaches the real proc and checks abortRequested.
    const map = new Map<string, ActiveTaskEntry>();
    const entry: ActiveTaskEntry = { proc: null, abortRequested: false };
    map.set("t-6", entry);

    // 1. Abort arrives during spawn.
    expect(handleAbort(map, "t-6", "SIGKILL")).toBe("pending");
    expect(entry.abortRequested).toBe(true);

    // 2. Spawn attaches the real proc and (in the real code) delivers the
    //    queued signal directly. This test just asserts the state required
    //    for that delivery exists.
    const proc = makeProc();
    entry.proc = proc;
    // Simulate the runTask attach-time check.
    if (entry.abortRequested) {
      proc.kill(entry.abortSignal ?? "SIGTERM");
    }
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("shutdownChildren", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, "exit").mockImplementation(
      ((_code?: number) => undefined) as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends SIGTERM to every live child, then SIGKILLs survivors after the grace period", () => {
    const a = makeProc();
    const b = makeProc();
    const map = new Map<string, ActiveTaskEntry>();
    map.set("a", { proc: a, abortRequested: false });
    map.set("b", { proc: b, abortRequested: false });

    shutdownChildren(map, "SIGTERM", 50);

    expect(a.kill).toHaveBeenCalledWith("SIGTERM");
    expect(b.kill).toHaveBeenCalledWith("SIGTERM");
    expect(process.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(a.kill).toHaveBeenCalledWith("SIGKILL");
    expect(b.kill).toHaveBeenCalledWith("SIGKILL");
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("threads SIGINT through as the initial signal", () => {
    const proc = makeProc();
    const map = new Map<string, ActiveTaskEntry>();
    map.set("a", { proc, abortRequested: false });

    shutdownChildren(map, "SIGINT", 50);

    expect(proc.kill).toHaveBeenCalledWith("SIGINT");

    vi.advanceTimersByTime(50);

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("only SIGKILLs procs that haven't already been killed", () => {
    const dead = makeProc({ killed: true });
    const alive = makeProc();
    const map = new Map<string, ActiveTaskEntry>();
    map.set("dead", { proc: dead, abortRequested: false });
    map.set("alive", { proc: alive, abortRequested: false });

    shutdownChildren(map, "SIGTERM", 50);
    vi.advanceTimersByTime(50);

    expect(dead.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(alive.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
