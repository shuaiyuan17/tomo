import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, devices, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";
import { STARTER_SCENE } from "../../src/home/starter.js";
import { homeSnapshotSchema, HOME_SNAPSHOT_MAX_BYTES, type WebHome } from "../../src/web/protocol.js";
import type { HomeScene } from "../../src/home/scene.js";
import type { HomeStatus } from "../../src/home/status.js";

/**
 * The Home page against the real web channel: `/api/v1/home`, its assets and
 * the snapshot upload are fulfilled here (the server side is not this
 * page's), while home / home-status / home-look events travel the real
 * event stream. WebGL runs on SwiftShader.
 */
installAgentTestHooks();
let agent: Agent;
let channel: WebChannel;
let browser: Browser;
let url: string;
beforeEach(async () => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  agent = new Agent();
  channel = new WebChannel(mockConfig.owner, undefined, { stop: (key) => agent.stopTurn(key),
    models: { view: (key) => agent.webModelView(key), switch: (key, model, from) => agent.switchModelFromWeb(key, model, from) } });
  const supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0 });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(new MockChannel("telegram"));
  await channel.start();
  url = `http://127.0.0.1:${supervisor.status().port}`;
  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  mkdirSync("test-results", { recursive: true });
});
afterEach(async () => { await browser?.close(); await agent.stop(); });

const DAY = { weather: "clear", phase: "day", progress: 0.4, tempC: 14 } as const;
function status(over: Partial<HomeStatus> = {}): HomeStatus {
  return { working: false, subagents: [], tasks: 0, compacting: false, idleSince: Date.now() - 20 * 60_000, sky: { ...DAY }, at: Date.now(), ...over };
}
interface Served { home: WebHome; snapshots: unknown[]; snapshotHeaders: Record<string, string>[]; assets: string[] }
/** Serves /home (whatever `served.home` holds at the time), the asset route and the snapshot upload. */
async function serveHome(page: Page, home: WebHome): Promise<Served> {
  const served: Served = { home, snapshots: [], snapshotHeaders: [], assets: [] };
  await page.route("**/api/v1/home", (route) => route.fulfill({ json: served.home }));
  await page.route("**/api/v1/home/assets/**", (route) => {
    served.assets.push(`${new URL(route.request().url()).pathname}|${route.request().resourceType()}`);
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#c7694f"/><circle cx="40" cy="30" r="18" fill="#f3cf6b"/></svg>' });
  });
  await page.route("**/api/v1/home/snapshot", (route) => {
    served.snapshots.push(route.request().postDataJSON()); served.snapshotHeaders.push(route.request().headers());
    return route.fulfill({ json: { ok: true } });
  });
  return served;
}
async function open(options: Parameters<Browser["newPage"]>[0], home: WebHome, theme?: "dark"): Promise<{ page: Page; served: Served; violations: () => Promise<string[]> }> {
  const page = await browser.newPage(options);
  await page.addInitScript((dark) => {
    (window as unknown as { cspViolations: string[] }).cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { cspViolations: string[] }).cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`));
    if (dark) localStorage.setItem("tomo-theme", "dark");
  }, theme === "dark");
  const served = await serveHome(page, home);
  await page.goto(`${url}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}`);
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toBeEnabled();
  return { page, served, violations: () => page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations) };
}
const homeOf = (over: Partial<WebHome> = {}): WebHome => ({ scene: STARTER_SCENE, revision: "r1", starter: true, status: status(), ...over });
const caption = (page: Page) => page.getByTestId("home-caption");
async function drawn(page: Page): Promise<void> {
  await browserExpect(page.locator('[data-testid="home-room"] [data-state="ready"]')).toBeVisible();
  await page.waitForTimeout(1_800); // let walks and fades finish
}
const publish = (event: Parameters<WebChannel["events"]["publish"]>[0]) => channel.events.publish(event);

it("opens Home from the sidebar, loads three.js only then, and follows the status live", async () => {
  const { page, served, violations } = await open({ viewport: { width: 1440, height: 900 } }, homeOf());
  const chunks: string[] = [];
  page.on("request", (request) => { if (/room-view-.*\.js$/.test(request.url())) chunks.push(request.url()); });
  await page.waitForTimeout(300);
  expect(chunks).toHaveLength(0);
  await page.getByRole("button", { name: "Home" }).click();
  await browserExpect(page).toHaveURL(/#home$/);
  await browserExpect(page.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await browserExpect(caption(page)).toHaveText(/^Idle for 20 min · 14°C, clear/);
  await browserExpect(page.getByText("This is the starter room; Tomo hasn't made one of its own yet.")).toBeVisible();
  await drawn(page);
  expect(chunks).toHaveLength(1);
  // The room fills the main area.
  const box = (await page.getByTestId("home-room").boundingBox())!;
  expect(box.width).toBeGreaterThan(1000); expect(box.height).toBeGreaterThan(650);
  await page.screenshot({ path: "test-results/home-idle-desktop.png" });

  publish({ type: "home-status", status: status({ working: true, by: "owner", tool: "shell", idleSince: undefined }) });
  await browserExpect(caption(page)).toHaveText(/^Working on your message · running a command/);
  await drawn(page);
  await page.screenshot({ path: "test-results/home-working-desktop.png" });

  publish({ type: "home-status", status: status({ working: true, by: "owner", tool: "subagent", idleSince: undefined, subagents: [
    { id: "a", type: "explore", task: "Read the cron store" }, { id: "b", type: "general-purpose", task: "Draft the reply" }, { id: "c", task: "Check the tests" }] }) });
  await browserExpect(caption(page)).toHaveText(/^Working on your message · 3 subagents/);
  await drawn(page);
  await page.screenshot({ path: "test-results/home-subagents-desktop.png" });

  // An older status (by the daemon's clock) never replaces a newer one.
  publish({ type: "home-status", status: status({ at: Date.now() - 60_000 }) });
  await page.waitForTimeout(300);
  await browserExpect(caption(page)).toHaveText(/3 subagents/);

  publish({ type: "home-status", status: status({ cronAt: Date.now(), working: true, by: "cron", idleSince: undefined }) });
  await browserExpect(caption(page)).toHaveText(/^Running a scheduled job/);
  await page.waitForTimeout(900);
  await page.screenshot({ path: "test-results/home-cron-desktop.png" });

  publish({ type: "home-status", status: status({ working: true, by: "owner", trouble: "rate_limit", idleSince: undefined }) });
  await browserExpect(caption(page)).toHaveText(/^Working on your message · rate-limited, waiting/);
  await drawn(page);
  await page.screenshot({ path: "test-results/home-trouble-desktop.png" });

  // Dragging turns the room (and nothing is uploaded unasked).
  const room = page.locator('[data-testid="home-room"] [data-state="ready"]');
  const before = await room.screenshot();
  const at = (await room.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2); await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + 160, at.y + at.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(200);
  expect(Buffer.compare(before, await room.screenshot())).not.toBe(0);
  expect(served.snapshots).toHaveLength(0);
  expect(await violations()).toEqual([]);
});

it("answers a home-look with a PNG inside the limit, re-reads on a home event, and shows a problem quietly", async () => {
  const { page, served } = await open({ viewport: { width: 1280, height: 800 } }, homeOf());
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  const requestId = crypto.randomUUID();
  publish({ type: "home-look", requestId });
  await browserExpect.poll(() => served.snapshots.length).toBe(1);
  const body = homeSnapshotSchema.parse(served.snapshots[0]);
  expect(body.requestId).toBe(requestId);
  expect(body.revision).toBe("r1");
  const png = Buffer.from(body.png, "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.length).toBeLessThanOrEqual(HOME_SNAPSHOT_MAX_BYTES);
  expect(served.snapshotHeaders[0]["x-tomo-csrf"]).toBeTruthy();
  expect(served.snapshotHeaders[0]["x-tomo-epoch"]).toBeTruthy();

  // Tomo wrote a scene with a picture and a mistake: the last good one shows, with a quiet note.
  const scene: HomeScene = { ...STARTER_SCENE, name: "With a picture", objects: [...STARTER_SCENE.objects, { picture: "art.svg", size: [0.8, 0.6, 0.04], at: [2.2, 1.9, -2.97] }] };
  served.home = homeOf({ scene, revision: "r2", starter: false, problems: ["objects[3].on: no object \"tabel\""] });
  publish({ type: "home", revision: "r2" });
  await browserExpect(page.getByText("Tomo's latest change has a problem; showing the last good room.")).toBeVisible();
  await browserExpect(page.getByText("This is the starter room", { exact: false })).toHaveCount(0);
  await browserExpect.poll(() => served.assets).toEqual(["/api/v1/home/assets/art.svg|image"]);
  await page.getByText("Tomo's latest change has a problem").click();
  await browserExpect(page.getByText('objects[3].on: no object "tabel"')).toBeVisible();
  await drawn(page);
  await page.screenshot({ path: "test-results/home-problem-desktop.png" });

  // A look while the Home page is not showing is not answered.
  await page.evaluate(() => { window.location.hash = ""; });
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toBeVisible();
  publish({ type: "home-look", requestId: crypto.randomUUID() });
  await page.waitForTimeout(500);
  expect(served.snapshots).toHaveLength(1);
});

it("draws the sky in the window: night, dusk, rain and snow, in both themes", async () => {
  const { page } = await open({ viewport: { width: 1440, height: 900 } }, homeOf(), "dark");
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  await page.screenshot({ path: "test-results/home-idle-desktop-dark.png" });
  for (const [name, sky, words] of [
    ["night", { weather: "clear", phase: "night", progress: 0.3, tempC: 6 }, "6°C, clear"],
    ["dusk", { weather: "clouds", phase: "dusk", progress: 0.95 }, "cloudy"],
    ["rain", { weather: "rain", phase: "day", progress: 0.5, tempC: 11 }, "11°C, raining"],
    ["snow", { weather: "snow", phase: "day", progress: 0.6, tempC: -2 }, "-2°C, snowing"],
  ] as const) {
    publish({ type: "home-status", status: status({ sky }) });
    await browserExpect(caption(page)).toHaveText(new RegExp(`· ${words}$`));
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/home-sky-${name}.png` });
  }
});

it("on a phone: the room fills the width under the header, and turns by a sideways drag", async () => {
  const { page, violations } = await open({ ...devices["iPhone 14"], defaultBrowserType: undefined }, homeOf());
  await page.getByRole("button", { name: /^Menu/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Home" }).click();
  await drawn(page);
  const room = (await page.getByTestId("home-room").boundingBox())!;
  expect(room.width).toBe(390);
  expect(room.y).toBeLessThan(52 + 1);
  // It fills the height down to the caption, with no fixed aspect.
  const line = (await caption(page).boundingBox())!;
  expect(line.y - (room.y + room.height)).toBeLessThan(24);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/home-idle-phone.png" });
  publish({ type: "home-status", status: status({ working: true, by: "owner", idleSince: undefined, subagents: [{ id: "a", task: "Look it up" }, { id: "b", type: "explore", task: "Search" }, { id: "c" }] }) });
  await browserExpect(caption(page)).toHaveText(/3 subagents/);
  await drawn(page);
  await page.screenshot({ path: "test-results/home-subagents-phone.png" });
  await page.evaluate(() => localStorage.setItem("tomo-theme", "dark"));
  await page.reload();
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  await page.screenshot({ path: "test-results/home-working-phone-dark.png" });
  // touch-action: pan-y keeps vertical swipes for the page.
  expect(await page.locator('[data-testid="home-room"] [data-state="ready"]').evaluate((element) => getComputedStyle(element).touchAction)).toBe("pan-y");
  expect(await violations()).toEqual([]);
});

it("without WebGL, or when the room's code fails to load, still says what Tomo is doing", async () => {
  const noGl = await open({ viewport: { width: 1280, height: 800 } }, homeOf({ status: status({ working: true, by: "cron", idleSince: undefined }) }));
  await noGl.page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      return kind.startsWith("webgl") || kind === "experimental-webgl" ? null : (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof original;
  });
  await noGl.page.goto(`${url}/?again=1#home`);
  await browserExpect(noGl.page.getByText("This browser can't draw the 3D room (WebGL is unavailable).", { exact: false })).toBeVisible();
  await browserExpect(caption(noGl.page)).toHaveText(/^Running a scheduled job/);
  await noGl.page.screenshot({ path: "test-results/home-no-webgl.png" });

  const failing = await open({ viewport: { width: 1280, height: 800 } }, homeOf());
  await failing.page.route(/room-view-.*\.js$/, (route) => route.abort());
  await failing.page.evaluate(() => { window.location.hash = "home"; });
  await browserExpect(failing.page.getByText("The room's drawing code didn't load.", { exact: false })).toBeVisible();
  await browserExpect(caption(failing.page)).toHaveText(/^Idle for 20 min/);
});

it("a scene at the format's limits draws without freezing the page", async () => {
  const objects: HomeScene["objects"] = Array.from({ length: 400 }, (_, i) => i % 4 === 0
    ? { sign: "{status} {idle}", size: [0.5, 0.2, 0.02], at: [-9 + (i % 20) * 0.9, 0.3 + Math.floor(i / 20) * 0.2, -9], color: "#2a2622", background: "#fbf8f1",
      reactions: [{ when: "working", do: "glow" }] }
    : { shape: (["box", "cylinder", "cone", "sphere"] as const)[i % 4], size: [0.4, 0.4, 0.4], at: [-9 + (i % 20) * 0.9, 0, -9 + Math.floor(i / 20) * 0.9],
      color: "#c7694f", reactions: [{ when: "working", do: "bob" }, { when: "working", do: "spin" }, { when: "idle", do: "pulse" }, { when: "cron", do: "swing" }, { when: "trouble", do: "tint", color: "#000000" }, { when: "night", do: "hide" }] });
  const scene: HomeScene = { version: 1, name: "Busy", room: { size: [20, 8, 20], floor: "#a9825b", walls: "#d9cdb6" }, objects };
  const { page } = await open({ viewport: { width: 1280, height: 800 } }, homeOf({ scene, starter: false, status: status({ working: true, by: "owner", idleSince: undefined }) }));
  const started = Date.now();
  await page.evaluate(() => { window.location.hash = "home"; });
  await browserExpect(page.locator('[data-testid="home-room"] [data-state="ready"]')).toBeVisible();
  // The page still answers while every part moves.
  const lag = await page.evaluate(() => new Promise<number>((done) => { const t = performance.now(); setTimeout(() => done(performance.now() - t), 0); }));
  expect(lag).toBeLessThan(1_000);
  expect(Date.now() - started).toBeLessThan(10_000);
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/home-limits.png" });
});

it("re-reads /home at least once a minute while the page shows in a visible tab", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.clock.install();
  const served = await serveHome(page, homeOf());
  // No room here: under a fake clock every animation frame would be run out in full.
  await page.route(/room-view-.*\.js$/, (route) => route.abort());
  let reads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/home") reads++; });
  await page.goto(`${url}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}#home`);
  await browserExpect(caption(page)).toHaveText(/^Idle/);
  const opened = reads;
  expect(opened).toBeGreaterThanOrEqual(1);
  // (The timing rule itself is unit-tested: homeReadDue. Here: the page keeps reading as time passes.)
  await page.clock.runFor(70_000);
  await browserExpect.poll(() => reads).toBeGreaterThan(opened);
  expect(served.snapshots).toHaveLength(0);
});

it("the pet sits near Tomo while awake and goes into its nest to sleep", async () => {
  const { page } = await open({ viewport: { width: 1440, height: 900 } }, homeOf({ status: status({ pet: "happy" }) }));
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  await page.screenshot({ path: "test-results/home-pet-awake.png" });
  publish({ type: "home-status", status: status({ pet: "sleeping" }) });
  await page.waitForTimeout(3_500); // it walks over
  await page.screenshot({ path: "test-results/home-pet-sleeping.png" });
  await browserExpect(caption(page)).toHaveText(/^Idle for 20 min/);
});
