/** Focused behavior-reversion evidence. Tests never change; each implementation
 * mutation runs in a disposable copy, then is restored before the next case. */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const source = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "tomo-web-mutations-"));
const evidence = join(source, "test-results", "mutations");
mkdirSync(evidence, { recursive: true });
const excluded = new Set(["node_modules", ".git", "dist", "coverage", "test-results", ".claude"]);
cpSync(source, temporary, { recursive: true, filter: (path) => !excluded.has(basename(path)) });
symlinkSync(join(source, "node_modules"), join(temporary, "node_modules"), "dir");

const cases = [
  ["enabled-default", "src/web/config.ts", "enabled: z.boolean().default(true)", "enabled: z.boolean().default(false)", "tests/web-channel.test.ts"],
  ["unique-owner", "src/web/owner.ts", "candidates.length === 1 ? candidates[0] : undefined", "candidates[0]", "tests/web-channel.test.ts"],
  ["owner-dm-routing", "src/router.ts", "sessionKey: this.maybeMigrate(owner, key)", 'sessionKey: "web:owner"', "tests/web-routing.test.ts"],
  ["group-channel-denial", "src/channels/web.ts", "input.targetId !== undefined && input.targetId !== this.ownerId", "false", "tests/web-channel.test.ts"],
  ["group-router-denial", "src/router.ts", 'chatId !== "owner" || isGroup', 'chatId !== "owner"', "tests/web-routing.test.ts"],
  ["provider-web-steering", "src/agent/inbound-batcher.ts", "&& this.host.canSteerIntoSession?.(sessionKey) !== false", "", "tests/web-routing.test.ts"],
  ["request-deduplication", "src/channels/web.ts", "if (previous) {", "if (previous && false) {", "tests/web-channel.test.ts"],
  ["completed-block-stream", "src/channels/web.ts", "try { this.events.publish(block); }", "try { void block; }", "tests/web-routing.test.ts"],
  ["mailbox-limit", "src/channels/web.ts", "this.blockBytes + bytes > MAX_BUFFER_BYTES - 64 * 1024", "false", "tests/web-channel.test.ts"],
  ["ingress-close", "src/channels/web.ts", "closeIngestion(): void { this.closed = true; }", "closeIngestion(): void {}", "tests/web-channel.test.ts"],
  ["safe-tool-activity", "src/channels/web.ts", "tool: event.tool.slice(0, 128)", 'tool: "omitted"', "tests/web-channel.test.ts"],
  ["event-replay", "src/web/events.ts", "this.ring.slice(index + 1).map(({ envelope }) => envelope)", "[]", "tests/web-channel.test.ts"],
  ["host-validation", "src/web/security.ts", "req.headers.host !== authority", "false", "tests/web-http.test.ts"],
  ["origin-validation", "src/web/security.ts", "req.headers.origin !== undefined && req.headers.origin !== origin", "false", "tests/web-http.test.ts"],
  ["csrf-validation", "src/web/http.ts", "csrf.verify(req);", "void req;", "tests/web-http.test.ts"],
  ["read-only-sessions", "src/sessions/store.ts", "if (!this.readOnly) mkdirSync(dir, { recursive: true });", "mkdirSync(dir, { recursive: true });", "tests/web-history.test.ts"],
  ["sidecar-history", "src/sessions/history-reader.ts", "sdkSessionsDir, key).reverse()", "sdkSessionsDir, key).slice(0, 1).reverse()", "tests/web-history.test.ts"],
  ["estimated-context", "src/sessions/store.ts", "entry.stats.contextEstimated = update.contextEstimated ?? false", "entry.stats.contextEstimated = false", "tests/web-history.test.ts"],
  ["child-restart", "src/web/supervisor.ts", "if (this.stopping || permanent) return;", "if (true) return;", "tests/web-supervisor.test.ts"],
  ["stale-epoch", "src/web/supervisor.ts", "input.epoch !== this.channel.events.epoch", "false", "tests/web-supervisor.test.ts"],
  ["hung-process-watchdog", "src/web/supervisor.ts", "Date.now() - lastPong > heartbeatMs * 5", "false", "tests/web-supervisor.test.ts"],
  ["queued-refusal", "src/agent.ts", 'channel.settleMessage?.(message.id, "refused");', "void message;", "tests/web-routing.test.ts"],
  ["automatic-start", "src/cli/start.ts", "if (config.web?.enabled) {", "if (false) {", "tests/web-startup.test.ts"],
  ["disable-ui", "src/cli/start.ts", "if (config.web?.enabled) {", "if (true) {", "tests/web-startup.test.ts"],
  ["messaging-requirement", "src/cli/start.ts", "assertChannelsConfigured();", "void 0;", "tests/web-startup.test.ts"],
  ["group-composer", "web/src/main.tsx", "disabled={!session?.writable} onChange", "disabled={false} onChange", "e2e"],
  ["theme-choice", "web/src/main.tsx", "document.documentElement.dataset.theme = theme", 'document.documentElement.dataset.theme = "light"', "e2e"],
  ["uncertain-draft", "web/src/main.tsx", "else setFeedback(labels.unknown);", 'else { setDraft(""); setFeedback(labels.unknown); }', "e2e"],
];
const results = [];
function run(args, timeout = 45_000) {
  return spawnSync(process.execPath, args, { cwd: temporary, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TOMO_LOG_FILE: "", TOMO_LOG_INLINE: "1" } });
}
function build() {
  for (const args of [["node_modules/typescript/bin/tsc"], ["node_modules/typescript/bin/tsc", "-p", "web/tsconfig.json"],
    ["node_modules/vite/bin/vite.js", "build", "--config", "web/vite.config.ts"]]) {
    const result = run(args); if (result.status !== 0) throw new Error(`Build failed: ${result.stdout}${result.stderr}`);
  }
}
try {
  const baseline = run(["node_modules/vitest/vitest.mjs", "run", ...new Set(cases.map((c) => c[4]).filter((s) => s !== "e2e"))]);
  writeFileSync(join(evidence, "baseline.log"), baseline.stdout + baseline.stderr);
  if (baseline.status !== 0) throw new Error("Baseline must pass before applying mutations");
  for (const [name, file, from, to, test] of cases) {
    const path = join(temporary, file); const original = readFileSync(path, "utf8");
    if (!original.includes(from)) throw new Error(`Mutation no longer matches: ${name}`);
    writeFileSync(path, original.replace(from, to));
    try {
      if (test === "e2e") build();
      const result = run(["node_modules/vitest/vitest.mjs", "run", ...(test === "e2e" ? ["--config", "vitest.e2e.config.ts"] : [test])]);
      const output = result.stdout + result.stderr;
      const killed = result.status !== null && result.status !== 0 && /AssertionError|expect\(locator\)/.test(output)
        && !/Transform failed|Failed to resolve|Cannot find module/.test(output);
      writeFileSync(join(evidence, `${name}.log`), output);
      results.push({ behavior: name, test, result: killed ? "behavioral failure observed" : "INVALID: investigate", exitCode: result.status });
      console.log(`${killed ? "PASS" : "FAIL"} ${name}`);
      if (!killed) process.exitCode = 1;
    } finally { writeFileSync(path, original); }
  }
  build();
  const restored = run(["node_modules/vitest/vitest.mjs", "run", ...new Set(cases.map((c) => c[4]).filter((s) => s !== "e2e"))]);
  const browser = run(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.e2e.config.ts"]);
  writeFileSync(join(evidence, "restored.log"), restored.stdout + restored.stderr + browser.stdout + browser.stderr);
  if (restored.status !== 0 || browser.status !== 0) throw new Error("Restored implementation must pass");
  writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
} finally { rmSync(temporary, { recursive: true, force: true }); }
