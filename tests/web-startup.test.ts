import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Channel } from "../src/channels/types.js";

// Exercise the actual foreground start command while replacing external
// transports/schedulers. Every runtime path belongs to this disposable root.
const fixture = vi.hoisted(() => ({ root: `/tmp/tomo-web-startup-${process.pid}-${Math.random().toString(36).slice(2)}`,
  enabled: true, constructionFails: false, registered: [] as Channel[], messages: [] as string[] }));
const assertChannels = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime-paths.js", () => ({ defaultRuntimePaths: {
  tomoHome: fixture.root, pidFile: `${fixture.root}/tomo.pid`, watchSocketPath: `${fixture.root}/watch.sock`,
} }));
vi.mock("../src/config.js", () => ({
  config: { get web() { return { enabled: fixture.enabled, port: 0 }; },
    identities: [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }],
    tomoHome: fixture.root, workspaceDir: `${fixture.root}/workspace`, sessionsDir: `${fixture.root}/sessions`,
    sdkSessionsDir: `${fixture.root}/sdk`, logsDir: `${fixture.root}/logs`, telegramToken: "synthetic-token",
    metrics: { enabled: false }, continuity: false,
  },
  assertConfigValid: () => {}, assertAuthConfigured: () => {}, assertChannelsConfigured: assertChannels,
  ignoredEnvOverrideNames: [], ignoredEnvOverridesNotice: () => "",
}));
vi.mock("../src/logger.js", () => ({ log: { info: (message: string) => fixture.messages.push(message), warn: () => {}, error: () => {} } }));
vi.mock("../src/process-handlers.js", () => ({ installBootstrapErrorHandlers: () => {}, installProcessErrorHandlers: () => {}, raiseFatal: (err: unknown) => { throw err; } }));
vi.mock("../src/agent.js", () => ({ Agent: class {
  addChannel(channel: Channel) { fixture.registered.push(channel); channel.onMessage(async () => true); }
  async start() { for (const channel of fixture.registered) await channel.start(); }
} }));
vi.mock("../src/channels/index.js", () => ({ TelegramChannel: class { name = "telegram"; onMessage() {} async start() {} async stop() {} } }));
vi.mock("../src/web/supervisor.js", async (original) => {
  const real = await original<typeof import("../src/web/supervisor.js")>();
  return { WebSupervisor: class extends real.WebSupervisor {
    constructor(...args: ConstructorParameters<typeof real.WebSupervisor>) {
      if (fixture.constructionFails) throw new Error("synthetic construction failure");
      super(args[0], { ...args[1], assetsDir: `${fixture.root}/assets` }, args[2]);
    }
  } };
});
vi.mock("../src/cron/scheduler.js", () => ({ CronScheduler: class { start() {} } }));
vi.mock("../src/cron/store.js", () => ({ CronStore: class {} }));
vi.mock("../src/mcp/pet-scheduler.js", () => ({ PetScheduler: class { start() {} } }));
vi.mock("../src/continuity.js", () => ({ ContinuityRunner: class {} }));
vi.mock("../src/version.js", () => ({ VersionChecker: class { start() {} }, getCurrentVersion: () => "test" }));
vi.mock("../src/lcm/runner.js", () => ({ RollupRunner: class { start() {} } }));
vi.mock("../src/watch/server.js", () => ({ WatchServer: class { start() {} } }));
vi.mock("../src/watch/snapshot.js", () => ({ buildWatchSnapshot: () => ({}) }));
vi.mock("../src/restart-request.js", () => ({ sweepStaleRestartRequests: () => {} }));

import { startCommand } from "../src/cli/start.js";
import { watchBus } from "../src/watch/bus.js";
const initialSigint = process.listeners("SIGINT");
const initialSigterm = process.listeners("SIGTERM");
beforeEach(() => {
  mkdirSync(fixture.root, { recursive: true }); fixture.enabled = true; fixture.constructionFails = false;
  mkdirSync(`${fixture.root}/assets`, { recursive: true });
  writeFileSync(`${fixture.root}/assets/index.html`, "<!doctype html><title>Tomo — Conversation</title>");
  fixture.registered = []; fixture.messages = []; assertChannels.mockClear(); watchBus.reset();
});
afterEach(async () => {
  for (const channel of fixture.registered) await channel.stop();
  for (const listener of process.listeners("SIGINT")) if (!initialSigint.includes(listener)) process.removeListener("SIGINT", listener);
  for (const listener of process.listeners("SIGTERM")) if (!initialSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
  rmSync(fixture.root, { recursive: true, force: true });
});
afterAll(() => watchBus.reset());

it("automatically serves the local web UI from tomo start and retains messaging startup validation", async () => {
  await startCommand.parseAsync(["--foreground"], { from: "user" });
  expect(assertChannels).toHaveBeenCalledOnce();
  expect(fixture.registered.map((channel) => channel.name)).toEqual(["telegram", "web"]);
  const message = fixture.messages.find((line) => typeof line === "string" && line.startsWith("Web UI: http://"));
  expect(message).toBeDefined();
  const response = await fetch(message!.slice("Web UI: ".length));
  expect(response.status).toBe(200); expect(await response.text()).toContain("Tomo — Conversation");
});
it("omits the UI when disabled", async () => {
  fixture.enabled = false;
  await startCommand.parseAsync(["--foreground"], { from: "user" });
  expect(fixture.registered.map((channel) => channel.name)).toEqual(["telegram"]);
});
it("continues starting messaging when optional web construction fails", async () => {
  fixture.constructionFails = true;
  await expect(startCommand.parseAsync(["--foreground"], { from: "user" })).resolves.toBeDefined();
  expect(fixture.registered.map((channel) => channel.name)).toEqual(["telegram"]);
});
it("still refuses startup without an existing messaging channel", async () => {
  assertChannels.mockImplementationOnce(() => { throw new Error("No messaging channel"); });
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("startup refused"); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(startCommand.parseAsync(["--foreground"], { from: "user" })).rejects.toThrow("startup refused");
    expect(fixture.registered).toEqual([]);
  } finally { exit.mockRestore(); error.mockRestore(); }
});
