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
const identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" as const }];
const headers = { "x-tomo-request": "1", "sec-fetch-site": "same-origin" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-web-process-"));
  channel = new WebChannel(identities); channel.onMessage(async () => true);
});
afterEach(async () => { await supervisor?.stop(); await channel.stop(); rmSync(root, { recursive: true, force: true }); });
function options() { return { tomoHome: root, identities, sessionsDir: join(root, "sessions"), sdkSessionsDir: join(root, "sdk"), port: 0 }; }

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

it("isolates an occupied port and reports an actionable diagnostic without repeated restarts", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as { port: number }).port;
  const diagnostic: string[] = [];
  try {
    supervisor = new WebSupervisor(channel, { ...options(), port, diagnostic: (text) => diagnostic.push(text) });
    await expect(supervisor.start()).resolves.toBeUndefined();
    expect(supervisor.status().port).toBeNull();
    expect(supervisor.status().restarts).toBe(0);
    expect(diagnostic.join(" ")).toContain("port is in use");
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});

it("times out a hung child, limits restart attempts, and shuts down promptly", async () => {
  const childPath = join(root, "hung.cjs");
  writeFileSync(childPath, "process.on('message', () => {}); setInterval(() => {}, 1000);");
  supervisor = new WebSupervisor(channel, options(), { childPath, startupMs: 100, heartbeatMs: 50, maxRestarts: 1 });
  const started = Date.now(); await supervisor.start();
  expect(Date.now() - started).toBeLessThan(1000);
  await expect.poll(() => supervisor.status(), { timeout: 3_000 }).toMatchObject({ restarts: 1, pid: null, port: null });
  const stopped = Date.now(); await supervisor.stop();
  expect(Date.now() - stopped).toBeLessThan(1000);
});

it("reaps a process whose event loop hangs after it reports ready", async () => {
  const childPath = join(root, "blocked.cjs");
  writeFileSync(childPath, "process.on('message', (m) => { if (m.type === 'init') { process.send({type:'ready', port:9465, accessToken:'a'.repeat(64)}); setTimeout(() => { for (;;) {} }, 10); } });");
  supervisor = new WebSupervisor(channel, options(), { childPath, startupMs: 1000, heartbeatMs: 50, maxRestarts: 0 });
  await supervisor.start();
  expect(supervisor.status().pid).toBeTypeOf("number");
  await expect.poll(() => supervisor.status().pid, { timeout: 2000 }).toBeNull();
});
