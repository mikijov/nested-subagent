/**
 * End-to-end session lifecycle test.
 *
 * Spawns the MCP server as a subprocess (via tsx) and drives it through the
 * Model Context Protocol stdio transport. Verifies:
 *   1. Task with persistSession=true returns a session_id in the result text.
 *   2. A second Task with resume=<id> reuses the same session and the agent
 *      remembers context from the first call.
 *
 * IMPORTANT: This test spawns real `claude -p` processes (twice) and incurs
 * API cost. Bounded by `maxBudgetUsd` per call to keep total under ~$0.10.
 * Run only with `npm run test:integration`.
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

interface TaskJson {
  ok: boolean;
  taskId: string;
  sessionId?: string;
  persisted?: boolean;
  result?: string;
  error?: string;
  errorKind?: string;
}

function parseTaskResult(result: unknown): TaskJson {
  const text = getResultText(result);
  return JSON.parse(text) as TaskJson;
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
    { name: "session-integration-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

describe("Session lifecycle (end-to-end via MCP stdio)", () => {
  it(
    "persists a session and resumes it with shared context",
    async () => {
      const { client, transport } = await makeClient();
      try {
        const first = await client.callTool({
          name: "Task",
          arguments: {
            prompt:
              "Reply with the single word ALPHA and nothing else. Do not use any tools.",
            model: "haiku",
            persistSession: true,
            maxBudgetUsd: 0.05,
            allowWrite: true,
          },
        });
        const parsed1 = parseTaskResult(first);
        expect(parsed1.ok, `expected ok=true, got: ${JSON.stringify(parsed1)}`).toBe(true);
        expect(parsed1.persisted).toBe(true);
        const sessionId = parsed1.sessionId;
        expect(sessionId, `expected sessionId in: ${JSON.stringify(parsed1)}`).toBeTruthy();

        const second = await client.callTool({
          name: "Task",
          arguments: {
            prompt:
              "Earlier I asked you to say one word. Reply with just that single word, no punctuation.",
            model: "haiku",
            resume: sessionId,
            maxBudgetUsd: 0.05,
            allowWrite: true,
          },
        });
        const parsed2 = parseTaskResult(second);
        // The agent should remember the prior context.
        expect(parsed2.result?.toUpperCase()).toContain("ALPHA");
        // The resumed run reports the same session ID.
        expect(parsed2.sessionId).toBe(sessionId);
      } finally {
        await transport.close();
      }
    },
    300000,
  );

  it("lists both Task and AbortTask in the tool registry", async () => {
    const { client, transport } = await makeClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["AbortTask", "Task"]);
    } finally {
      await transport.close();
    }
  }, 30000);

  it("AbortTask returns not_found for an unknown taskId", async () => {
    const { client, transport } = await makeClient();
    try {
      const result = await client.callTool({
        name: "AbortTask",
        arguments: { taskId: "does-not-exist" },
      });
      expect(getResultText(result)).toContain("not_found");
    } finally {
      await transport.close();
    }
  }, 30000);
});
