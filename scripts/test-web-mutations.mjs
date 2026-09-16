/** Focused behavior-reversion evidence. Tests never change; each implementation
 * mutation runs in a disposable copy, then is restored before the next case. */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { controlPanelCases } from "./control-panel-mutations.mjs";

const source = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "tomo-web-mutations-"));
const evidence = join(source, "test-results", process.env.MUTATIONS ? "mutations-filtered" : "mutations");
mkdirSync(evidence, { recursive: true });
const excluded = new Set(["node_modules", ".git", "dist", "coverage", "test-results", ".claude"]);
cpSync(source, temporary, { recursive: true, filter: (path) => !excluded.has(basename(path)) });
symlinkSync(join(source, "node_modules"), join(temporary, "node_modules"), "dir");

const allCases = [
  ...controlPanelCases,
  ["access-log-permissions","src/web/token-store.ts","const fd = openSync(temporary, \"wx\", 0o600);","const fd = openSync(temporary, \"wx\", 0o644);","tests/web-access.test.ts"],
  ["web-token-redaction","src/redact.ts","  [/\\btomo_web_[a-f0-9]{64}\\b/g, \"***\"],","","tests/web-access.test.ts"],
  ["unicode-body-limit","src/web/protocol.ts","MAX_BODY_BYTES = 128 * 1024","MAX_BODY_BYTES = 32 * 1024","tests/web-http.test.ts"],
  ["csrf-recovery","web/src/api.ts","const fresh = await refresh();","throw error; const fresh = await refresh();","tests/web-http.test.ts"],
  ["private-api-auth","src/web/http.ts","access.require(req, origin)) : undefined","\"unauthenticated\") : undefined","tests/web-http.test.ts"],
  ["bootstrap-auth","src/web/access.ts","throw new WebError(401, \"authentication_required\");\n    }","void supplied;\n    }","tests/web-access.test.ts"],
  ["secure-cookie","src/web/access.ts","origin.startsWith(\"https:\") ? \"; Secure\" : \"\"","false ? \"; Secure\" : \"\"","tests/web-access.test.ts"],
  ["token-private-mode","src/web/token-store.ts","(stat.mode & 0o777) === 0o600","true","tests/web-access.test.ts"],
  ["token-reuse","src/web/token-store.ts","if (validAccessToken(token)) return token;","if (false) return token;","tests/web-access.test.ts"],
  ["tailnet-allowlist","src/web/security.ts","...(externalOrigin ? [externalOrigin] : [])","...([])","tests/web-http.test.ts"],
  ["receipt-eviction","src/channels/web.ts","this.receipts.delete(oldest[0]);","throw new WebError(429, \"request_limit\");","tests/web-channel.test.ts"],
  ["active-receipts","src/channels/web.ts","filter((r) => !r.settled)","filter((r) => [\"queued\", \"running\"].includes(r.request.state))","tests/web-channel.test.ts"],
  ["history-status","src/web/data.ts","error.code === \"invalid_cursor\" ? 400 : error.code === \"history_changed\" ? 409 : 413","503","tests/web-http.test.ts"],
  ["config-diagnostic","src/config.ts","parseWebConfig(file.web, (message) => log.warn(message))","parseWebConfig(file.web)","tests/web-config.test.ts"],
  ["supervisor-stop-start","src/web/supervisor.ts",".finally(() => { this.starting = undefined; })",".finally(() => {})","tests/web-supervisor.test.ts"],
  ["transient-replay","src/web/http.ts","if (item.event.type === \"tool\" || item.event.type === \"typing\") write(\"update\", item.event);","if (false) write(\"update\", item.event);","tests/web-http.test.ts"],
  ["url-token-removal","web/src/api.ts","url.searchParams.delete(\"t\");","void url;","e2e"],
  ["oversize-feedback","web/src/main.tsx","err.status === 413 ? \"Message is too large. Shorten it and send again; your draft is kept.\"","false ? \"Message is too large. Shorten it and send again; your draft is kept.\"","e2e"],
  ["history-recovery","web/src/main.tsx","error instanceof ApiError && error.status === 409 && error.code === \"history_changed\"","false","e2e"],
  ["enabled-default", "src/web/config.ts", "enabled: z.boolean().default(true)", "enabled: z.boolean().default(false)", "tests/web-channel.test.ts"],
  ["unique-owner", "src/web/owner.ts", "candidates.length === 1 ? candidates[0] : undefined", "candidates[0]", "tests/web-channel.test.ts"],
  ["owner-dm-routing", "src/router.ts", "sessionKey: this.maybeMigrate(owner, key)", 'sessionKey: "web:owner"', "tests/web-routing.test.ts"],
  ["group-channel-denial", "src/channels/web.ts", "input.targetId !== undefined && input.targetId !== this.ownerId", "false", "tests/web-channel.test.ts"],
  ["group-router-denial", "src/router.ts", 'chatId !== "owner" || isGroup', 'chatId !== "owner"', "tests/web-routing.test.ts"],
  ["provider-web-steering", "src/agent/inbound-batcher.ts", "&& this.host.canSteerIntoSession?.(sessionKey) !== false", "", "tests/web-routing.test.ts"],
  ["request-deduplication", "src/channels/web.ts", "if (previous) {", "if (previous && false) {", "tests/web-channel.test.ts"],
  ["completed-block-stream", "src/channels/web.ts", "try { this.events.publish(block); }", "try { void block; }", "tests/web-routing.test.ts"],
  ["mailbox-limit", "src/channels/web.ts", "this.blockBytes + bytes + this.pendingTextBytes > MAX_BUFFER_BYTES - 64 * 1024", "false", "tests/web-channel.test.ts"],
  ["ingress-close", "src/channels/web.ts", "closeIngestion(): void { this.closed = true; }", "closeIngestion(): void {}", "tests/web-channel.test.ts"],
  ["safe-tool-activity", "src/channels/web.ts", "tool: event.tool.slice(0, 128)", 'tool: "omitted"', "tests/web-channel.test.ts"],
  ["event-replay", "src/web/events.ts", "this.ring.slice(index + 1).map(({ envelope }) => envelope)", "[]", "tests/web-channel.test.ts"],
  ["host-validation", "src/web/security.ts", "hostCount !== 1 || !origin", "false", "tests/web-http.test.ts"],
  ["origin-validation", "src/web/security.ts", "req.headers.origin !== undefined && req.headers.origin !== origin", "false", "tests/web-http.test.ts"],
  ["csrf-validation", "src/web/http.ts", "csrf.verify(req, session!);", "void req;", "tests/web-http.test.ts"],
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
const cases = process.env.MUTATIONS ? allCases.filter(([name]) => new RegExp(process.env.MUTATIONS).test(name)) : allCases;
if (!cases.length) throw new Error("No matching mutations");
for (const [name, file, from] of cases) if (!readFileSync(join(temporary, file), "utf8").includes(from)) throw new Error(`Mutation no longer matches: ${name}`);
const results = [];
function run(args, timeout = 120_000) {
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
  for (const [name, file, from, to, test, filter] of cases) {
    const path = join(temporary, file); const original = readFileSync(path, "utf8");
    if (!original.includes(from)) throw new Error(`Mutation no longer matches: ${name}`);
    writeFileSync(path, original.replace(from, to));
    try {
      if (test === "e2e") build();
      const result = run(["node_modules/vitest/vitest.mjs", "run", ...(test === "e2e" ? ["--config", "vitest.e2e.config.ts"] : [test]), ...(filter ? ["-t", filter] : [])]);
      const output = result.stdout + result.stderr;
      const killed = result.status !== null && result.status !== 0 && /AssertionError|expect\(locator\)/.test(output)
        && !/Transform failed|Failed to resolve|Cannot find module/.test(output);
      writeFileSync(join(evidence, `${name}.log`), output);
      results.push({ behavior: name, test, result: killed ? "behavioral failure observed" : "INVALID: investigate", exitCode: result.status });
      console.log(`${killed ? "PASS" : "FAIL"} ${name}`);
      writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
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
