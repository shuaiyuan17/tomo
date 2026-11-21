import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Runs the REAL CLI against a local fake of the Messages API, so no model, no
// account and no real credential are involved. It answers the questions a mock
// SDK cannot: does a PostToolUse rewrite reach the model AND the session file,
// and what does a failing command do?
const home = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/tomo-broker-e2e-${process.pid}`;
  process.env.TOMO_HOME = dir;
  return dir;
});

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { buildHooksOption } from "../../src/agent/sdk-options.js";
import { clearSecretValuesForTests, markRedactionReady, registerSecretValue } from "../../src/credentials/redactor.js";

const FAKE = "fake-e2e-credential-3f9a1c7d";
type Step = { name: string; input: Record<string, unknown> };
let server: Server;
let baseUrl: string;
const configDirs: string[] = [];
let cwd: string;
let steps: Step[] = [];
let toolResults: unknown[] = [];

function sse(res: ServerResponse, content: Record<string, unknown>, stop: string, partial?: string): void {
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  send("message_start", { message: { id: "msg_e2e", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  send("content_block_start", { index: 0, content_block: content });
  send("content_block_delta", { index: 0, delta: partial === undefined ? { type: "text_delta", text: "done" } : { type: "input_json_delta", partial_json: partial } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  res.end();
}

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "tomo-broker-e2e-cwd-"));
  registerSecretValue(FAKE, "user/e2e");
  // As after the broker's first successful load.
  markRedactionReady();
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const parsed = JSON.parse(body) as { messages: Array<{ content: unknown }>; tools?: unknown[] };
      const last = parsed.messages.at(-1)?.content;
      if (Array.isArray(last)) {
        for (const block of last as Array<{ type: string }>) {
          if (block.type === "tool_result") toolResults.push(block);
        }
      }
      const step = parsed.tools?.length ? steps.shift() : undefined;
      if (!step) {
        sse(res, { type: "text", text: "" }, "end_turn");
        return;
      }
      sse(res, { type: "tool_use", id: `toolu_${Date.now()}`, name: step.name, input: {} }, "tool_use", JSON.stringify(step.input));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  clearSecretValuesForTests();
  server.close();
  for (const dir of [...configDirs, cwd, home]) rmSync(dir, { recursive: true, force: true });
});

function sessionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sessionFiles(path);
    return path.endsWith(".jsonl") ? [path] : [];
  });
}

async function runSteps(next: Step[], hooks: Record<string, unknown>): Promise<{ results: string; files: string }> {
  steps = [...next];
  toolResults = [];
  // One config dir per run, so a session file only ever holds this run's traffic.
  const configDir = mkdtempSync(join(tmpdir(), "tomo-broker-e2e-cfg-"));
  configDirs.push(configDir);
  const mcp = createSdkMcpServer({
    name: "probe",
    version: "0.0.1",
    tools: [tool("leak", "returns the fake value", {}, async () => ({ content: [{ type: "text" as const, text: `mcp says ${FAKE}` }] }))],
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "fake-api-key-for-e2e",
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    FAKE_E2E_VALUE: FAKE,
  };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const run = query({
    prompt: "go",
    options: {
      cwd,
      env,
      model: "claude-sonnet-4-6",
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Bash", "mcp__probe__leak"],
      mcpServers: { probe: mcp },
      ...(hooks as object),
    },
  });
  while (!(await run.next()).done) { /* drain */ }
  return {
    results: JSON.stringify(toolResults),
    files: sessionFiles(configDir).map((file) => readFileSync(file, "utf8")).join("\n"),
  };
}

const guarded = () => buildHooksOption({ maxTurns: 10, sessionKey: "dm:e2e", credentialBroker: true });

it("scrubs a successful Bash result from the model request and the session file", async () => {
  const { results, files } = await runSteps([{ name: "Bash", input: { command: 'printf "got %s\\n" "$FAKE_E2E_VALUE"', description: "probe" } }], guarded());
  expect(results).toContain("[REDACTED secret://user/e2e]");
  expect(results).not.toContain(FAKE);
  expect(files).not.toContain(FAKE);
}, 60_000);

// The pattern the agent is told to use, with a careless echo: the command text
// holds only the substitution, and the value it yields is masked in the result.
it("masks a value read with $(security … -w) and echoed, from the model and the session file", async () => {
  const command = 'security() { printf "%s\\n" "$FAKE_E2E_VALUE"; }; echo "token=$(security find-generic-password -s tomo-credential-broker -a e2e -w)"';
  const { results, files } = await runSteps([{ name: "Bash", input: { command, description: "probe" } }], guarded());
  expect(results).toContain("token=[REDACTED secret://user/e2e]");
  expect(results).not.toContain(FAKE);
  expect(files).toContain("find-generic-password");
  expect(files).not.toContain(FAKE);
}, 60_000);

it("pins a known limit: the CLI cannot rewrite a failing Bash, so it is not scrubbed", async () => {
  const { results } = await runSteps(
    [{ name: "Bash", input: { command: 'printf "got %s\\n" "$FAKE_E2E_VALUE"; exit 3', description: "probe" } }],
    guarded(),
  );
  expect(results).toContain(FAKE);
}, 60_000);

// Tripwire for the limit above. PostToolUseFailure's output type has only
// `additionalContext` (sdk.d.ts, PostToolUseFailureHookSpecificOutput), and the
// CLI ignores a rewrite returned from it. If this starts failing, the CLI can
// rewrite failed output: wire the redactor to PostToolUseFailure.
it("pins that a PostToolUseFailure hook cannot rewrite a failed Bash's output either", async () => {
  let fired = 0;
  const failureHook = { PostToolUseFailure: [{ hooks: [async () => {
    fired++;
    return { hookSpecificOutput: { hookEventName: "PostToolUseFailure", updatedToolOutput: "rewritten", additionalContext: "rewritten" } };
  }] }] };
  const base = guarded() as { hooks: Record<string, unknown> };
  const { results } = await runSteps(
    [{ name: "Bash", input: { command: 'printf "got %s\\n" "$FAKE_E2E_VALUE"; exit 3', description: "probe" } }],
    { ...base, hooks: { ...base.hooks, ...failureHook } },
  );
  expect(fired).toBe(1);
  expect(results).toContain(FAKE);
}, 60_000);

it("scrubs an in-process MCP tool's result", async () => {
  const { results, files } = await runSteps([{ name: "mcp__probe__leak", input: {} }], guarded());
  expect(results).toContain("[REDACTED secret://user/e2e]");
  expect(results).not.toContain(FAKE);
  expect(files).not.toContain(FAKE);
}, 60_000);

// Tripwire: `onFailure: "block"` on PostToolUse does NOT replace the output. A
// callback that throws under "block" adds a failure notice, and the ORIGINAL
// result still reaches the model and the session file. That is why the redactor
// withholds inside its own callback instead of relying on "block". If this
// starts failing, the CLI now drops output on a blocked PostToolUse.
it("pins that a throwing PostToolUse callback under onFailure: block still delivers the original output", async () => {
  let fired = 0;
  const throwing = { hooks: { PostToolUse: [{ onFailure: "block", hooks: [async () => { fired++; throw new Error("e2e boom"); }] }] } };
  const { results, files } = await runSteps(
    [{ name: "Bash", input: { command: 'printf "got %s\\n" "$FAKE_E2E_VALUE"', description: "probe" } }],
    throwing,
  );
  expect(fired).toBe(1);
  expect(results).toContain("blocking because onFailure is");
  expect(results).toContain(FAKE);
  expect(files).toContain(FAKE);
}, 60_000);
