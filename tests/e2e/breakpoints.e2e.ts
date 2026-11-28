/**
 * The two shell widths at their edges: the script (layers.ts) and the stylesheet (`max-phone:`,
 * `max-overlay:`) must switch at the same pixel. When they did not (1024 and 600 wide), the Tasks
 * rail was a modal with a scrim over the page while the stylesheet still pinned it, and at 600 the
 * sidebar was shown but inert, with the menu button hidden.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, SessionStore, installAgentTestHooks, mockConfig } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";
import { OutgoingMediaStore, outgoingImagesDir } from "../../src/web/outgoing-media.js";
import { uploadsDir } from "../../src/web/uploads.js";

installAgentTestHooks();
let agent: Agent;
let channel: WebChannel;
let provider: MockChannel;
let supervisor: WebSupervisor;
let browser: Browser;
let page: Page;
let url: string;
beforeEach(async () => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir, { dbPath: mockConfig.dbPath });
  store.setChatTitle("telegram:-1", "Test group");
  store.append("telegram:-1", { role: "user", content: "A shared group note.", channel: "telegram", timestamp: Date.now() });
  agent = new Agent(); channel = new WebChannel(mockConfig.owner, undefined, { compact: (key, settled) => agent.requestOwnerCompact(key, settled),
    outgoingMedia: new OutgoingMediaStore(outgoingImagesDir(mockConfig.workspaceDir), { isPrivate: (path) => path.includes("/memory/private/") }),
    uploads: { dir: uploadsDir(mockConfig.tomoHome), workspaceDir: mockConfig.workspaceDir } }); provider = new MockChannel("telegram");
  supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0 });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(provider);
  await channel.start();
  expect(supervisor.status().port).toBeTypeOf("number");
  url = `http://127.0.0.1:${supervisor.status().port}`;
  browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${url}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}`);
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("t")).toBe(false);
});
afterEach(async () => { await browser?.close(); await agent.stop(); });

const shell = () => page.evaluate(() => {
  const sidebar = document.getElementById("sidebar")!;
  const menu = document.querySelector<HTMLElement>("[aria-controls=sidebar]")!;
  const rail = document.getElementById("tasks-rail");
  const scrims = [...document.querySelectorAll<HTMLElement>("div[aria-hidden=true]")].filter((d) => d.className.includes("bg-black/20")).length;
  return { sidebarDrawer: getComputedStyle(sidebar).position === "fixed", sidebarInert: sidebar.inert, menuShown: getComputedStyle(menu).display !== "none",
    rail: rail && { fixed: getComputedStyle(rail).position === "fixed", modal: rail.getAttribute("aria-modal") === "true" }, scrims };
});
/** Loads the app at this width, so both sides start there (no resize for one of them to lag behind). */
const at = async (width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.reload();
  await browserExpect(page.locator("[data-connection=live]")).toBeAttached();
};
const openTasks = async () => {
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await browserExpect(page.locator("#tasks-rail[data-state=open]")).toBeVisible();
};

it.each([
  [1023, { fixed: true, modal: true }, 1],
  [1024, { fixed: false, modal: false }, 0],
  [1025, { fixed: false, modal: false }, 0],
])("at %i wide the Tasks rail is laid out as the script treats it", async (width, rail, scrims) => {
  await at(width, 768);
  await openTasks();
  expect(await shell()).toMatchObject({ rail, scrims });
});

it.each([
  [599, { sidebarDrawer: true, sidebarInert: true, menuShown: true }],
  [600, { sidebarDrawer: false, sidebarInert: false, menuShown: false }],
  [601, { sidebarDrawer: false, sidebarInert: false, menuShown: false }],
])("at %i wide the sidebar is laid out as the script treats it", async (width, expected) => {
  await at(width, 800);
  expect(await shell()).toMatchObject(expected);
});
