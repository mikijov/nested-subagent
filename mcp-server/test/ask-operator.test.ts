import { describe, expect, it } from "vitest";
import {
  ASK_OPERATOR_SENTINEL_CLOSE as CLOSE,
  ASK_OPERATOR_SENTINEL_OPEN as OPEN,
  parseNeedsInput,
  type NeedsInputQuestion,
} from "../src/session.js";

const validQ: NeedsInputQuestion = {
  question: "Which database should we use?",
  header: "DB",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "Open source SQL" },
    { label: "SQLite", description: "Embedded SQL" },
  ],
};

const validPayload = JSON.stringify({ questions: [validQ] });

describe("parseNeedsInput — null / empty / no-sentinel inputs", () => {
  it("returns null for null", () => {
    expect(parseNeedsInput(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseNeedsInput(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseNeedsInput("")).toBeNull();
  });

  it("returns null when no sentinels appear", () => {
    expect(parseNeedsInput("Just a normal completion message.")).toBeNull();
  });

  it("returns null when only the opening sentinel appears", () => {
    expect(parseNeedsInput(`${OPEN}\n${validPayload}\n`)).toBeNull();
  });

  it("returns null when only the closing sentinel appears", () => {
    expect(parseNeedsInput(`some text\n${CLOSE}`)).toBeNull();
  });

  it("returns null when the close sentinel precedes the open sentinel", () => {
    // Counts are 1/1 so we get past the count gate, but the regex requires
    // open-then-close in that order.
    expect(parseNeedsInput(`${CLOSE}${validPayload}${OPEN}`)).toBeNull();
  });

  it("returns null when two complete sentinel pairs appear", () => {
    const text = `${OPEN}\n${validPayload}\n${CLOSE}\nand later\n${OPEN}\n${validPayload}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when the body between sentinels is empty/whitespace", () => {
    expect(parseNeedsInput(`${OPEN}\n   \n${CLOSE}`)).toBeNull();
  });
});

describe("parseNeedsInput — happy paths", () => {
  it("parses a well-formed single-question block", () => {
    const text = `Some preamble.\n${OPEN}\n${validPayload}\n${CLOSE}\n`;
    expect(parseNeedsInput(text)).toEqual({ questions: [validQ] });
  });

  it("tolerates a ```json fenced JSON body", () => {
    const text = `${OPEN}\n\`\`\`json\n${validPayload}\n\`\`\`\n${CLOSE}`;
    expect(parseNeedsInput(text)).toEqual({ questions: [validQ] });
  });

  it("tolerates a plain ``` fenced JSON body", () => {
    const text = `${OPEN}\n\`\`\`\n${validPayload}\n\`\`\`\n${CLOSE}`;
    expect(parseNeedsInput(text)).toEqual({ questions: [validQ] });
  });

  it("rejects a fenced body with no newline after the language tag (strict)", () => {
    // ```json{...}``` (no newline after the tag) is unusual markdown form.
    // The parser strips the leading 3 backticks but leaves "json" stuck to
    // the JSON body, so JSON.parse fails → null. Documented strictness.
    const text = `${OPEN}\n\`\`\`json${validPayload}\`\`\`\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("preserves optional preview on options", () => {
    const q: NeedsInputQuestion = {
      ...validQ,
      options: [
        { label: "A", description: "alpha", preview: "preview-a" },
        { label: "B", description: "beta" },
      ],
    };
    const text = `${OPEN}\n${JSON.stringify({ questions: [q] })}\n${CLOSE}`;
    const got = parseNeedsInput(text);
    expect(got?.questions[0].options[0]).toEqual({
      label: "A",
      description: "alpha",
      preview: "preview-a",
    });
    expect(got?.questions[0].options[1].preview).toBeUndefined();
  });

  it("accepts the maximum bound (4 questions × 4 options)", () => {
    const big4: NeedsInputQuestion = {
      ...validQ,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
        { label: "C", description: "c" },
        { label: "D", description: "d" },
      ],
    };
    const payload = JSON.stringify({
      questions: [big4, big4, big4, big4],
    });
    const got = parseNeedsInput(`${OPEN}\n${payload}\n${CLOSE}`);
    expect(got?.questions).toHaveLength(4);
    expect(got?.questions[0].options).toHaveLength(4);
  });

  it("accepts multiSelect=true", () => {
    const q = { ...validQ, multiSelect: true };
    const text = `${OPEN}\n${JSON.stringify({ questions: [q] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)?.questions[0].multiSelect).toBe(true);
  });
});

describe("parseNeedsInput — malformed JSON / shape violations", () => {
  it("returns null when JSON is malformed", () => {
    expect(parseNeedsInput(`${OPEN}\n{not json,}\n${CLOSE}`)).toBeNull();
  });

  it("returns null when the questions field is missing", () => {
    const text = `${OPEN}\n${JSON.stringify({ foo: "bar" })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when questions is not an array", () => {
    const text = `${OPEN}\n${JSON.stringify({ questions: "nope" })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when questions is empty", () => {
    const text = `${OPEN}\n${JSON.stringify({ questions: [] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when 5+ questions are supplied", () => {
    const five = Array.from({ length: 5 }, () => validQ);
    const text = `${OPEN}\n${JSON.stringify({ questions: five })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when a question has only one option", () => {
    const bad: NeedsInputQuestion = {
      ...validQ,
      options: [validQ.options[0]],
    };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when a question has 5 options", () => {
    const bad: NeedsInputQuestion = {
      ...validQ,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
        { label: "C", description: "c" },
        { label: "D", description: "d" },
        { label: "E", description: "e" },
      ],
    };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when multiSelect is missing", () => {
    const bad = { ...validQ } as Record<string, unknown>;
    delete bad.multiSelect;
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when multiSelect is non-boolean", () => {
    const bad = { ...validQ, multiSelect: "false" as unknown as boolean };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when header is empty", () => {
    const bad = { ...validQ, header: "" };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when header exceeds 12 characters", () => {
    const bad = { ...validQ, header: "ThisHeaderIsWayTooLong" };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when an option label is empty", () => {
    const bad: NeedsInputQuestion = {
      ...validQ,
      options: [
        { label: "", description: "a" },
        { label: "B", description: "b" },
      ],
    };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });

  it("returns null when preview is a non-string value", () => {
    const bad = {
      ...validQ,
      options: [
        { label: "A", description: "a", preview: 42 as unknown as string },
        { label: "B", description: "b" },
      ],
    };
    const text = `${OPEN}\n${JSON.stringify({ questions: [bad] })}\n${CLOSE}`;
    expect(parseNeedsInput(text)).toBeNull();
  });
});
