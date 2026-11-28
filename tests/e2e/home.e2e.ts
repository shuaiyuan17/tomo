import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, devices, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig, mockSdk } from "../helpers/agent-harness.js";
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

/**
 * Every test here draws the room on a software rasteriser (SwiftShader) and waits for walks and
 * fades to finish; the longest takes about 21 s on a quiet machine, which a busy CI runner
 * stretches past the suite's 30 s default.
 */
const ROOM_TEST_TIMEOUT_MS = 90_000;

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
  await browserExpect(caption(page)).toHaveText(/^Working on your message · 3 helpers/);
  await drawn(page);
  await page.screenshot({ path: "test-results/home-subagents-desktop.png" });

  // An older status (by the daemon's clock) never replaces a newer one.
  publish({ type: "home-status", status: status({ at: Date.now() - 60_000 }) });
  await page.waitForTimeout(300);
  await browserExpect(caption(page)).toHaveText(/3 helpers/);

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
}, ROOM_TEST_TIMEOUT_MS);

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
}, ROOM_TEST_TIMEOUT_MS);

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
}, ROOM_TEST_TIMEOUT_MS);

it("on a phone: the room fills the width under the header, and its view is the owner's to move", async () => {
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
  await browserExpect(caption(page)).toHaveText(/3 helpers/);
  await drawn(page);
  await page.screenshot({ path: "test-results/home-subagents-phone.png" });
  await page.evaluate(() => localStorage.setItem("tomo-theme", "dark"));
  await page.reload();
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  await page.screenshot({ path: "test-results/home-working-phone-dark.png" });
  // touch-action: none: a gesture on the room orbits, pinches or pans it, and never fights the page's scrolling.
  expect(await page.locator('[data-testid="home-room"] [data-state="ready"]').evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
  expect(await page.locator('[data-testid="home-room"] canvas').evaluate((element) => getComputedStyle(element).touchAction)).toBe("none");
  expect(await violations()).toEqual([]);
}, ROOM_TEST_TIMEOUT_MS);

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
}, ROOM_TEST_TIMEOUT_MS);

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
}, ROOM_TEST_TIMEOUT_MS);

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
}, ROOM_TEST_TIMEOUT_MS);

it("the pet sits near Tomo while awake and goes into its nest to sleep", async () => {
  const { page } = await open({ viewport: { width: 1440, height: 900 } }, homeOf({ status: status({ pet: "happy" }) }));
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  await page.screenshot({ path: "test-results/home-pet-awake.png" });
  publish({ type: "home-status", status: status({ pet: "sleeping" }) });
  await page.waitForTimeout(3_500); // it walks over
  await page.screenshot({ path: "test-results/home-pet-sleeping.png" });
  await browserExpect(caption(page)).toHaveText(/^Idle for 20 min/);
}, ROOM_TEST_TIMEOUT_MS);

it("back from another app on a phone: the scrim is gone, nothing stays inert, and the status is read again", async () => {
  const { page, served } = await open({ ...devices["iPhone 14"], defaultBrowserType: undefined }, homeOf());
  let reads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/home") reads++; });
  await page.getByRole("button", { name: /^Menu/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Home" }).click();
  await browserExpect(caption(page)).toHaveText(/^Idle for 20 min/);
  // While the page is away a background subagent starts; the stream never says so.
  served.home = homeOf({ status: status({ subagents: [{ id: "bg", type: "general-purpose" }] }) });
  const before = reads;
  // The drawer is open when the owner switches apps.
  await page.getByRole("button", { name: /^Menu/ }).click();
  await browserExpect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => {
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await browserExpect(page.getByRole("button", { name: /^Menu/ })).toHaveAttribute("aria-expanded", "false");
  await browserExpect(page.getByRole("dialog")).toHaveCount(0);
  // No backdrop left over the page, the header is on top at its own spot, nothing is inert.
  await browserExpect(page.locator(".fixed.inset-0.bg-black\\/20")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const header = document.querySelector("header")!;
    const box = header.getBoundingClientRect();
    return { top: box.top, hit: header.contains(document.elementFromPoint(box.left + box.width / 2, box.bottom - 4)), scrolled: scrollY,
      inert: [...document.querySelectorAll("main, header")].some((el) => (el as HTMLElement).inert) };
  })).toEqual({ top: 0, hit: true, scrolled: 0, inert: false });
  // The page reconnected and read /home again: the visitor shows.
  await browserExpect(caption(page)).toHaveText(/1 helper/);
  expect(reads).toBeGreaterThan(before);
});

interface View { distance: number; azimuth: number; elevation: number; target: [number, number, number] }
const viewOf = async (page: Page): Promise<View> => JSON.parse((await page.getByTestId("home-view").getAttribute("data-view"))!) as View;
/** Waits for the damped glide to settle: the view stops changing. */
async function settled(page: Page): Promise<View> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const now = (await page.getByTestId("home-view").getAttribute("data-view")) ?? "";
    if (now === last) break;
    last = now; await page.waitForTimeout(150);
  }
  return viewOf(page);
}

it("the owner looks round the room: orbit all the way, zoom and pan within limits, double-click to reset", async () => {
  const { page } = await open({ viewport: { width: 1280, height: 800 } }, homeOf());
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  const start = await viewOf(page);
  const box = (await page.getByTestId("home-view").boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const drag = async (dx: number, dy: number, options: { button?: "left" | "right"; shift?: boolean } = {}) => {
    if (options.shift) await page.keyboard.down("Shift");
    await page.mouse.move(mid.x, mid.y); await page.mouse.down({ button: options.button ?? "left" });
    await page.mouse.move(mid.x + dx, mid.y + dy, { steps: 12 }); await page.mouse.up({ button: options.button ?? "left" });
    if (options.shift) await page.keyboard.up("Shift");
    return settled(page);
  };

  // Orbit: far past the old ±40° limit, round to the other side of the room.
  const turned = await drag(-300, 0);
  const swing = Math.abs(((turned.azimuth - start.azimuth + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  expect(swing).toBeGreaterThan(1.2);
  await browserExpect(page.getByRole("button", { name: "Reset view" })).toBeVisible();
  // Tilt: never under the floor, never straight down.
  const low = await drag(0, -2000);
  expect(low.elevation).toBeGreaterThanOrEqual(10 * Math.PI / 180 - 0.01);
  expect(low.elevation).toBeLessThan(start.elevation);
  const high = await drag(0, 2000);
  expect(high.elevation).toBeLessThanOrEqual(85 * Math.PI / 180 + 0.01);
  expect(high.elevation).toBeGreaterThan(start.elevation);

  // Zoom: the wheel brings the camera in, and only so far (it never goes through a wall), then out, and only so far.
  await page.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
  const near = await settled(page);
  expect(near.distance).toBeLessThan(start.distance);
  expect(near.distance).toBeGreaterThanOrEqual(Math.hypot(6, 6) / 2 - 0.01); // the starter room is 6 x 6
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 400);
  const far = await settled(page);
  expect(far.distance).toBeGreaterThan(start.distance);
  expect(far.distance).toBeLessThanOrEqual(start.distance * 1.8 + 0.01);

  // Pan: right drag and Shift drag move what the camera looks at, never far from the room.
  const before = (await settled(page)).target;
  const panned = (await drag(4000, 2500, { button: "right" })).target;
  expect(panned).not.toEqual(before);
  const shifted = (await drag(-4000, -2500, { shift: true })).target;
  expect(shifted).not.toEqual(panned);
  for (const target of [panned, shifted]) expect(Math.hypot(target[0] - start.target[0], target[1] - start.target[1], target[2] - start.target[2])).toBeLessThanOrEqual(6 / 4 + 0.01);

  // Double-click: back to the default view.
  await page.mouse.dblclick(mid.x, mid.y);
  expect(await settled(page)).toEqual(start);
  await browserExpect(page.getByRole("button", { name: "Reset view" })).toHaveCount(0);

  // The keyboard still turns it (and Home resets it); so does the reset button.
  await page.getByTestId("home-view").focus();
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("-");
  const keyed = await settled(page);
  expect(keyed.azimuth).not.toBe(start.azimuth); expect(keyed.elevation).toBeGreaterThan(start.elevation); expect(keyed.distance).toBeGreaterThan(start.distance);
  await page.getByRole("button", { name: "Reset view" }).click();
  expect(await settled(page)).toEqual(start);
}, ROOM_TEST_TIMEOUT_MS);

it("with reduced motion the view stops where the owner lets go (no glide)", async () => {
  const { page } = await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" }, homeOf());
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  const box = (await page.getByTestId("home-view").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
  const released = await viewOf(page);
  await page.waitForTimeout(600);
  expect(await viewOf(page)).toEqual(released);
}, ROOM_TEST_TIMEOUT_MS);

it("the conversation opens beside the room: same stream as the Conversation page, the canvas re-fits; narrow, it is an overlay", async () => {
  const { page } = await open({ viewport: { width: 1440, height: 900 } }, homeOf());
  mockSdk.responseFn = () => "Seen from the room.";
  await page.evaluate(() => { window.location.hash = "home"; });
  await drawn(page);
  const canvas = page.locator('[data-testid="home-view"] canvas');
  const before = (await canvas.boundingBox())!.width;
  const toggle = page.getByRole("button", { name: /^Conversation beside the room/ });
  await browserExpect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const panel = page.getByRole("main", { name: "Conversation" });
  await browserExpect(panel).toBeVisible();
  const input = panel.getByRole("textbox", { name: "Message Tomo" });
  await browserExpect(input).toBeFocused();
  await input.fill("Hello from Home"); await input.press("Enter");
  await browserExpect(panel.getByText("Seen from the room.", { exact: true })).toBeVisible();
  // The room gives up the panel's width and re-fits its drawing buffer (no stretching).
  await browserExpect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(before - 300);
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(380); expect(box.width).toBeLessThanOrEqual(440);
  await browserExpect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => Math.abs(c.width / c.clientWidth - c.height / c.clientHeight))).toBeLessThan(0.02);
  expect(await page.evaluate(() => localStorage.getItem("tomo-home-chat-open"))).toBe("1");
  await page.keyboard.press("Escape");
  await browserExpect(panel).toBeHidden();
  await browserExpect(toggle).toBeFocused();
  // The Conversation page is the same conversation: the message once, the reply once.
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await browserExpect(page.getByText("Seen from the room.", { exact: true })).toHaveCount(1);
  await browserExpect(page.getByText("Hello from Home", { exact: true })).toHaveCount(1);
  await page.close();

  // Narrow: a modal sheet over the room with a scrim; a click on the scrim closes it, and so does a resume.
  const narrow = await open({ viewport: { width: 820, height: 900 } }, homeOf());
  await narrow.page.evaluate(() => { window.location.hash = "home"; });
  await narrow.page.getByRole("button", { name: /^Conversation beside the room/ }).click();
  const sheet = narrow.page.getByRole("dialog", { name: "Conversation" });
  await browserExpect(sheet).toBeVisible();
  await browserExpect(sheet.getByRole("textbox", { name: "Message Tomo" })).toBeEnabled();
  await browserExpect(sheet.getByText("Seen from the room.", { exact: true })).toBeVisible();
  await browserExpect(narrow.page.locator("#home")).toHaveAttribute("inert", "");
  await narrow.page.getByTestId("chat-scrim").click({ position: { x: 20, y: 300 } });
  await browserExpect(sheet).toBeHidden();
  await browserExpect(narrow.page.locator("#home")).not.toHaveAttribute("inert", "");
  await narrow.page.getByRole("button", { name: /^Conversation beside the room/ }).click();
  await browserExpect(sheet).toBeVisible();
  await narrow.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await browserExpect(sheet).toBeHidden();
}, ROOM_TEST_TIMEOUT_MS);
