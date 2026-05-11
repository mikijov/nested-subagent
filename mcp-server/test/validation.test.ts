import { describe, expect, it } from "vitest";
import { validateSessionParams, type TaskInput } from "../src/session.js";

const base: TaskInput = { prompt: "hi" };

describe("validateSessionParams — rejections", () => {
  it("rejects resume + continueRecent (mutually exclusive)", () => {
    const err = validateSessionParams({
      ...base,
      resume: "u-1",
      continueRecent: true,
    });
    expect(err).toMatch(/mutually exclusive/i);
  });

  it("rejects explicit persistSession=false with resume", () => {
    const err = validateSessionParams({
      ...base,
      resume: "u-1",
      persistSession: false,
    });
    expect(err).toMatch(/persistSession=false/);
  });

  it("rejects explicit persistSession=false with continueRecent", () => {
    const err = validateSessionParams({
      ...base,
      continueRecent: true,
      persistSession: false,
    });
    expect(err).toMatch(/persistSession=false/);
  });

  it("rejects explicit persistSession=false with sessionId", () => {
    const err = validateSessionParams({
      ...base,
      sessionId: "u-2",
      persistSession: false,
    });
    expect(err).toMatch(/persistSession=false/);
  });

  it("rejects explicit persistSession=false with forkSession", () => {
    const err = validateSessionParams({
      ...base,
      resume: "u-1",
      forkSession: true,
      persistSession: false,
    });
    expect(err).toMatch(/persistSession=false/);
  });

  it("rejects forkSession without resume or continueRecent", () => {
    const err = validateSessionParams({ ...base, forkSession: true });
    expect(err).toMatch(/forkSession requires resume or continueRecent/);
  });

  it("rejects sessionId + resume without forkSession (CLI requires fork)", () => {
    const err = validateSessionParams({
      ...base,
      resume: "u-1",
      sessionId: "u-2",
    });
    expect(err).toMatch(/sessionId combined with resume\/continueRecent requires forkSession/);
  });

  it("rejects sessionId + continueRecent without forkSession", () => {
    const err = validateSessionParams({
      ...base,
      continueRecent: true,
      sessionId: "u-2",
    });
    expect(err).toMatch(/sessionId combined with resume\/continueRecent requires forkSession/);
  });
});

describe("validateSessionParams — acceptances", () => {
  it("accepts default (no session params)", () => {
    expect(validateSessionParams(base)).toBeNull();
  });

  it("accepts resume alone", () => {
    expect(validateSessionParams({ ...base, resume: "u-1" })).toBeNull();
  });

  it("accepts continueRecent alone", () => {
    expect(
      validateSessionParams({ ...base, continueRecent: true }),
    ).toBeNull();
  });

  it("accepts sessionId alone (names a new session)", () => {
    expect(validateSessionParams({ ...base, sessionId: "u-2" })).toBeNull();
  });

  it("accepts sessionId + resume + forkSession", () => {
    expect(
      validateSessionParams({
        ...base,
        resume: "u-1",
        sessionId: "u-2",
        forkSession: true,
      }),
    ).toBeNull();
  });

  it("accepts resume + forkSession (no sessionId — CLI assigns one)", () => {
    expect(
      validateSessionParams({ ...base, resume: "u-1", forkSession: true }),
    ).toBeNull();
  });

  it("accepts persistSession=true alone", () => {
    expect(
      validateSessionParams({ ...base, persistSession: true }),
    ).toBeNull();
  });
});
