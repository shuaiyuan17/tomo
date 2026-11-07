import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSupervisor } from "../src/web/supervisor.js";
import { WebChannel } from "../src/channels/web.js";
import type { WebBootstrap } from "../src/web/protocol.js";

let root: string;
let channel: WebChannel;
let supervisor: WebSupervisor;
const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
const headers = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-process-"));
  channel = new WebChannel(owner); channel.onMessage(async () => true);
});
afterEach(async () => { await supervisor?.stop(); await channel.stop(); rmSync(root, { recursive: true, force: true }); });
function options() { return { tomoHome: root, owner, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"), port: 0 }; }

it("fails closed without blocking its channel when the token cannot be persisted", async () => {
  mkdirSync(join(root, "web-token"));
  supervisor = new WebSupervisor(channel, options(), { maxRestarts: 0 });
  channel.attach(supervisor);
  await expect(channel.start()).resolves.toBeUndefined();
  expect(supervisor.status().port).toBeNull();
});

it("starts again after a completed stop and reuses its access token", async () => {
  supervisor = new WebSupervisor(channel, options());
  await supervisor.start();
  const pid = supervisor.status().pid;
  const token = readFileSync(join(root, "web-token"), "utf8");
  await supervisor.stop(); await supervisor.start();
  expect(supervisor.status().pid).toBeTypeOf("number");
  expect(supervisor.status().pid).not.toBe(pid);
  expect(supervisor.status().port).toBeTypeOf("number");
  expect(readFileSync(join(root, "web-token"), "utf8")).toBe(token);
});

it("keeps receipts and replay across a real web process crash/restart", async () => {
  supervisor = new WebSupervisor(channel, options());
  channel.attach(supervisor); await channel.start();
  expect(supervisor.status().port).toBeTypeOf("number");
  const requestId = randomUUID(); await channel.receive({ requestId, text: "accepted" });
  await channel.send({ chatId: requestId, text: "queued block" });
  const previous = supervisor.status().pid!;
  process.kill(previous, "SIGKILL");
  await expect.poll(() => supervisor.status().pid, { timeout: 6_000 }).not.toBe(previous);
  await expect.poll(() => supervisor.status().port, { timeout: 6_000 }).toBeTypeOf("number");
  const response = await fetch(`http://127.0.0.1:${supervisor.status().port}/api/v1/bootstrap?t=${readFileSync(join(root, "web-token"), "utf8").trim()}`, { headers });
  expect(response.status).toBe(200);
  const bootstrap = await response.json() as WebBootstrap;
  expect(bootstrap.epoch).toBe(channel.events.epoch);
  expect(bootstrap.blocks[0].text).toBe("queued block");
  expect(bootstrap.requests[0].requestId).toBe(requestId);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const message = await fetch(`http://127.0.0.1:${supervisor.status().port}/api/v1/messages`, { method: "POST",
    headers: { ...headers, cookie, origin: `http://127.0.0.1:${supervisor.status().port}`,
      "content-type": "application/json", "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": randomUUID() },
    body: JSON.stringify({ requestId: randomUUID(), text: "stale browser" }) });
  expect(message.status).toBe(409);
  expect(await message.json()).toEqual({ error: "epoch_changed" });
}, 12_000);

it("reports an occupied port at error level and comes up once the port is free", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as { port: number }).port;
  const diagnostic: Array<[string, string | undefined]> = [];
  let open = true;
  try {
    supervisor = new WebSupervisor(channel, { ...options(), port, diagnostic: (text, level) => diagnostic.push([text, level]) },
      { baseBackoffMs: 100, maxBackoffMs: 200 });
    await expect(supervisor.start()).resolves.toBeUndefined();
    expect(supervisor.status().port).toBeNull();
    expect(diagnostic).toContainEqual(["Web UI port is in use; choose another web.port and restart.", "error"]);
    await expect.poll(() => supervisor.status().state, { timeout: 2_000 }).toBe("backoff");
    await new Promise<void>((resolve) => occupied.close(() => resolve())); open = false;
    await expect.poll(() => supervisor.status().port, { timeout: 5_000 }).toBe(port);
    expect(supervisor.status().state).toBe("running");
    // One error line for the whole outage, however many retries it took.
    expect(diagnostic.filter(([text, level]) => level === "error" && text.includes("port is in use"))).toHaveLength(1);
  } finally { if (open) await new Promise<void>((resolve) => occupied.close(() => resolve())); }
}, 10_000);

/** A child that fails its first `failures` starts, then serves normally. */
function flakyChild(failures: number): string {
  const childPath = join(root, "flaky.cjs");
  const counter = join(root, "starts");
  writeFileSync(childPath, `
    const fs = require("node:fs");
    let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")); } catch {}
    fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
    if (n < ${failures}) process.exit(1);
    process.on("message", (m) => {
      if (m.type === "init") process.send({ type: "ready", port: 9465, accessToken: "tomo_web_" + "a".repeat(64) });
      if (m.type === "ping") process.send({ type: "pong" });
    });`);
  return childPath;
}

it("never gives up: keeps retrying with capped backoff past the old three-failure limit", async () => {
  const diagnostic: Array<[string, string | undefined]> = [];
  supervisor = new WebSupervisor(channel, { ...options(), diagnostic: (text, level) => diagnostic.push([text, level]) },
    { childPath: flakyChild(6), startupMs: 2_000, heartbeatMs: 1_000, baseBackoffMs: 20, maxBackoffMs: 80 });
  await supervisor.start();
  await expect.poll(() => supervisor.status().state, { timeout: 8_000 }).toBe("running");
  expect(supervisor.status().port).toBe(9465);
  // Exactly one error-level line, when quick restarts stopped working.
  const errors = diagnostic.filter(([, level]) => level === "error").map(([text]) => text);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/Web UI down after 3 consecutive failed start\(s\); retrying in/);
  expect(diagnostic.map(([text]) => text)).toContain("Web UI recovered after 6 consecutive failed start(s).");
  const status = JSON.parse(readFileSync(join(root, "web-status.json"), "utf8")) as { state: string; daemonPid: number };
  expect(status).toMatchObject({ state: "running", daemonPid: process.pid });
}, 15_000);

it("forgets consecutive failures only after the child has stayed healthy", async () => {
  supervisor = new WebSupervisor(channel, options(),
    { childPath: flakyChild(2), startupMs: 2_000, heartbeatMs: 1_000, baseBackoffMs: 20, maxBackoffMs: 80, healthyResetMs: 300 });
  await supervisor.start();
  await expect.poll(() => supervisor.status().state, { timeout: 8_000 }).toBe("running");
  expect(supervisor.status().restarts).toBe(2);
  await expect.poll(() => supervisor.status().restarts, { timeout: 2_000 }).toBe(0);
}, 12_000);

it("times out a hung child, limits restart attempts, and shuts down promptly", async () => {
  const childPath = join(root, "hung.cjs");
  writeFileSync(childPath, "process.on('message', () => {}); setInterval(() => {}, 1000);");
  supervisor = new WebSupervisor(channel, options(), { childPath, startupMs: 100, heartbeatMs: 50, maxRestarts: 1 });
  const started = Date.now(); await supervisor.start();
  expect(Date.now() - started).toBeLessThan(1000);
  await expect.poll(() => supervisor.status(), { timeout: 3_000 }).toMatchObject({ restarts: 1, pid: null, port: null, state: "failed" });
  const stopped = Date.now(); await supervisor.stop();
  expect(Date.now() - stopped).toBeLessThan(1000);
});

it("reaps a process whose event loop hangs after it reports ready", async () => {
  const childPath = join(root, "blocked.cjs");
  writeFileSync(childPath, "process.on('message', (m) => { if (m.type === 'init') { process.send({type:'ready', port:9465, accessToken:'tomo_web_'+'a'.repeat(64)}); setTimeout(() => { for (;;) {} }, 10); } });");
  supervisor = new WebSupervisor(channel, options(), { childPath, startupMs: 1000, heartbeatMs: 50, maxRestarts: 0 });
  await supervisor.start();
  expect(supervisor.status().pid).toBeTypeOf("number");
  await expect.poll(() => supervisor.status().pid, { timeout: 2000 }).toBeNull();
});

it("a start() during backoff cancels the pending restart instead of racing it", async () => {
  supervisor = new WebSupervisor(channel, options(),
    { childPath: flakyChild(1), startupMs: 2_000, heartbeatMs: 1_000, baseBackoffMs: 1_500, maxBackoffMs: 1_500 });
  await supervisor.start();
  await expect.poll(() => supervisor.status().state, { timeout: 3_000 }).toBe("backoff");
  await supervisor.start();
  await expect.poll(() => supervisor.status().state, { timeout: 3_000 }).toBe("running");
  const pid = supervisor.status().pid;
  // Past the moment the cancelled restart would have fired.
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  expect(supervisor.status().pid).toBe(pid);
  expect(Number(readFileSync(join(root, "starts"), "utf8"))).toBe(2);
}, 10_000);
