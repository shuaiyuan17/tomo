import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";
import { HomeService } from "../../src/home/service.js";
import { STARTER_SCENE } from "../../src/home/starter.js";

/**
 * Tomo's home END TO END: the real page against the real server and the real
 * daemon-side service. Nothing is stubbed in the browser: the scene comes
 * from the store through /api/v1/home, status from the watch bus through the
 * reducer and the event stream, pictures from the asset route, and the
 * snapshot goes back through the upload route to `look()`, which is what
 * the home_check tool calls. (home.e2e.ts covers the page's own behaviour
 * against a stubbed server; this file is the seam between the two halves.)
 */
installAgentTestHooks();
let agent: Agent;
let channel: WebChannel;
let home: HomeService;
let browser: Browser;
let page: Page;
let homeDir: string;
beforeEach(async () => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  agent = new Agent();
  homeDir = join(mockConfig.workspaceDir, "home");
  home = new HomeService({ workspaceDir: mockConfig.workspaceDir, lastGoodPath: join(mockConfig.tomoHome, "data", "home", "last-good.json"), debounceMs: 20, pollMs: 100 });
  channel = new WebChannel(mockConfig.owner, undefined, { home: { view: () => home.web(), snapshot: (input) => home.deliverSnapshot(input) } });
  const supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0 });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(new MockChannel("telegram"));
  home.attachWeb({ publish: (event) => channel.events.publish(event), available: () => supervisor.status().state === "running", mayShowTask: (key) => channel.mayShowTask(key) });
  await channel.start();
  home.start();
  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(`http://127.0.0.1:${supervisor.status().port}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}#home`);
  mkdirSync("test-results", { recursive: true });
});
afterEach(async () => { home.stop(); await browser?.close(); await agent.stop(); });

const writeScene = (scene: unknown) => { mkdirSync(homeDir, { recursive: true }); writeFileSync(join(homeDir, "scene.json"), typeof scene === "string" ? scene : JSON.stringify(scene)); };

it("the starter room, live status, Tomo's own scene, a broken scene, a picture, and the look back, all through the real server", async () => {
  // 1. Nothing written yet: the starter room, drawn, and said to be the starter.
  await browserExpect(page.locator("canvas").first()).toBeVisible();
  await browserExpect(page.getByText("This is the starter room")).toBeVisible();
  await browserExpect(page.getByText(/^Idle/)).toBeVisible();

  // 2. What Tomo does reaches the caption through the bus, the reducer and the event stream.
  watchBus.publish({ type: "turn.start", sessionKey: "dm:owner", source: "user" });
  await browserExpect(page.getByText(/^Working on your message/)).toBeVisible();
  watchBus.publish({ type: "turn.end", sessionKey: "dm:owner", source: "user", ok: true, durationMs: 5 });
  await browserExpect(page.getByText(/^Idle/)).toBeVisible();

  // 3. Tomo writes its own room: the page follows without a reload.
  const mine = { ...structuredClone(STARTER_SCENE), name: "Reading nook" };
  writeScene(mine);
  await browserExpect(page.getByText("Reading nook")).toBeVisible();
  await browserExpect(page.getByText("This is the starter room")).toHaveCount(0);

  // 4. Tomo breaks the file: the last good room stays, and the page says why.
  writeScene('{ "version": 1, "room": ');
  await browserExpect(page.getByText(/latest change has a problem; showing the last good room/)).toBeVisible();
  await browserExpect(page.getByText("Reading nook")).toBeVisible();
  await browserExpect(page.locator("canvas").first()).toBeVisible();

  // 5. A picture Tomo hangs is served from home/assets as an image, and only from there.
  mkdirSync(join(homeDir, "assets"), { recursive: true });
  writeFileSync(join(homeDir, "assets", "sunrise.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#c7694f"/></svg>');
  const asset = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/home/assets/sunrise.svg");
  writeScene({ ...mine, objects: [...mine.objects, { picture: "sunrise.svg", size: [0.8, 0.6, 0.03], at: [1.2, 1.5, -2.95] }] });
  const served = await asset;
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toContain("image/svg+xml");
  await browserExpect(page.getByText(/latest change has a problem/)).toHaveCount(0);
  expect(await page.evaluate(() => fetch("/api/v1/home/assets/..%2Fscene.json").then((response) => response.status))).toBe(404);

  // 6. Tomo looks at its home: the open page answers with a real picture of the room it is showing.
  const looked = await home.look(home.web().revision);
  expect(looked).toMatchObject({ status: "picture" });
  if (looked.status !== "picture") throw new Error("no picture");
  expect(looked.snapshot.png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(looked.snapshot.png.length).toBeGreaterThan(2_000);
  writeFileSync("test-results/home-as-tomo-sees-it.png", looked.snapshot.png);
  await page.screenshot({ path: "test-results/home-real-desktop.png" });
});

it("with no browser on the Home page, a look comes back without a picture", async () => {
  await browserExpect(page.locator("canvas").first()).toBeVisible();
  await page.evaluate(() => { window.location.hash = ""; });
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toBeVisible();
  // Asked, but no Home page is showing to answer: Tomo is told there is no picture, within the wait it allowed.
  const started = Date.now();
  const looked = await home.look(home.web().revision, 1_500);
  expect(looked.status).toBe("no_browser");
  expect(Date.now() - started).toBeLessThan(3_000);
});
