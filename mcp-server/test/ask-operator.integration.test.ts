/**
 * End-to-end askOperator test.
 *
 * Spawns the MCP server as a subprocess (via tsx) and drives it through the
 * Model Context Protocol stdio transport. Verifies the three-call dance:
 *   1. Task with askOperator=true → subagent emits the sentinel block.
 *   2. Plugin parses it; response carries `needsInput.questions` and a
 *      persisted sessionId.
 *   3. Task with resume=<sessionId> + freeform answer prompt → subagent
 *      completes normally (no further needsInput).
 *
 * IMPORTANT: This test spawns real `claude -p` processes (twice) and incurs
 * API cost. Bounded by `maxBudgetUsd: 0.10` per call to keep total under ~$0.20.
 * Run only with `npm run test:integration`.
 *
 * Model + effort: haiku at `effort: "low"`. Extended-thinking burn (the plugin
 * default is xhigh) blows past a $0.05 budget on this task before the model
 * gets to emit the sentinel block — low effort is enough for "produce a small
 * JSON block" and brings each call back under $0.02. If this test starts going
 * flaky on the first call (no `needsInput`, or malformed JSON inside the
 * sentinels), the first remediation is to bump `model` to `"sonnet"` — Sonnet
 * follows instructions more consistently. The plugin code itself doesn't
 * model-discriminate.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_CWD = resolve(__dirname, "..");
const TSX_BIN = resolve(MCP_SERVER_CWD, "node_modules/.bin/tsx");
const SERVER_ENTRY = resolve(MCP_SERVER_CWD, "src/index.ts");

interface ToolContent {
  type: string;
  text?: string;
}

function getResultText(result: unknown): string {
  const content = (result as { content?: ToolContent[] }).content ?? [];
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

interface NeedsInputOptionJson {
  label: string;
  description: string;
  preview?: string;
}

interface NeedsInputQuestionJson {
  question: string;
  header: string;
  multiSelect: boolean;
  options: NeedsInputOptionJson[];
}

interface TaskJson {
  ok: boolean;
  taskId: string;
  sessionId?: string;
  persisted?: boolean;
  result?: string;
  error?: string;
  errorKind?: string;
  needsInput?: { questions: NeedsInputQuestionJson[] };
}

function parseTaskResult(result: unknown): TaskJson {
  return JSON.parse(getResultText(result)) as TaskJson;
}

async function makeClient(): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [SERVER_ENTRY],
    cwd: MCP_SERVER_CWD,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
  const client = new Client(
    { name: "ask-operator-integration-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

describe("askOperator (end-to-end via MCP stdio)", () => {
  it(
    "subagent → needsInput → resume with answer → completion",
    async () => {
      const { client, transport } = await makeClient();
      try {
        const first = await client.callTool({
          name: "Task",
          arguments: {
            prompt:
              "I want a fruit recommendation but haven't told you whether I want a citrus fruit or a stone fruit. Use the operator escape hatch protocol from your system prompt to ask me which category I want. Use header 'Fruit' (≤12 chars). Provide exactly two options with labels 'Citrus' and 'Stone' and one-sentence descriptions. Emit ONLY the sentinel block and the JSON between them — no other text in your final message.",
            model: "haiku",
            effort: "low",
            askOperator: true,
            maxBudgetUsd: 0.1,
            dangerouslySkipPermissions: true,
          },
        });
        const parsed1 = parseTaskResult(first);
        expect(
          parsed1.ok,
          `expected ok=true, got: ${JSON.stringify(parsed1)}`,
        ).toBe(true);
        expect(parsed1.persisted).toBe(true);
        expect(parsed1.sessionId).toBeTruthy();
        expect(
          parsed1.needsInput,
          `expected needsInput, got: ${JSON.stringify(parsed1)}`,
        ).toBeTruthy();
        expect(parsed1.needsInput!.questions.length).toBeGreaterThanOrEqual(1);
        const labelsLower = parsed1
          .needsInput!.questions[0].options.map((o) => o.label.toLowerCase())
          .join(",");
        expect(labelsLower).toContain("citrus");
        expect(labelsLower).toContain("stone");

        const second = await client.callTool({
          name: "Task",
          arguments: {
            prompt:
              "The operator answered: Citrus. Now name one specific citrus fruit (just the name, lowercase, no punctuation) and stop. Do NOT emit the sentinel block again.",
            model: "haiku",
            effort: "low",
            resume: parsed1.sessionId,
            maxBudgetUsd: 0.1,
            dangerouslySkipPermissions: true,
          },
        });
        const parsed2 = parseTaskResult(second);
        expect(parsed2.ok).toBe(true);
        expect(parsed2.sessionId).toBe(parsed1.sessionId);
        expect(parsed2.needsInput).toBeUndefined();
        expect(parsed2.result?.toLowerCase()).toMatch(
          /orange|lemon|lime|grapefruit|tangerine|mandarin|pomelo|kumquat|clementine/,
        );
      } finally {
        await transport.close();
      }
    },
    300000,
  );
});
