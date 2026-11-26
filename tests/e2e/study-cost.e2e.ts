import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, devices, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig } from "../helpers/agent-harness.js";
import { seedCostLedger, type CostFixtureOptions } from "../helpers/cost-fixture.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";

installAgentTestHooks();
let agent: Agent;
let supervisor: WebSupervisor;
let browser: Browser;
let url: string;
beforeEach(() => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  mkdirSync("test-results", { recursive: true });
});
afterEach(async () => { await browser?.close(); await agent?.stop(); });

/** Seeds the ledger (or not), then boots the web stack: the web process reads the ledger itself. */
async function boot(ledger: CostFixtureOptions | null): Promise<void> {
  if (ledger) seedCostLedger(mockConfig.tomoHome, ledger);
  agent = new Agent();
  const channel = new WebChannel(mockConfig.owner, undefined, { stop: (key) => agent.stopTurn(key) });
  supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0 });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(new MockChannel("telegram"));
  await channel.start();
  url = `http://127.0.0.1:${supervisor.status().port}`;
  browser = await chromium.launch();
}
async function open(options: Parameters<Browser["newPage"]>[0], hash = "study/cost"): Promise<Page> {
  const page = await browser.newPage(options);
  await page.goto(`${url}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}#${hash}`);
  await browserExpect(page.locator("#study")).toBeVisible();
  return page;
}
/** Local `YYYY-MM-DD` `back` days ago: the web process splits days on this machine's clock here. */
function day(back: number): string {
  const d = new Date(); d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

it("sits between Model and Cron, opens on today, and a picked day survives a reload", async () => {
  await boot({});
  const page = await open({ viewport: { width: 1280, height: 900 } }, "study/todos");
  const tabs = await page.getByRole("tab").allTextContents();
  expect(tabs.slice(tabs.indexOf("Model"), tabs.indexOf("Model") + 3)).toEqual(["Model", "Cost", "Cron"]);
  await page.getByRole("tab", { name: "Cost" }).click();
  await browserExpect(page).toHaveURL(/#study\/cost$/);
  await browserExpect(page.getByRole("heading", { level: 1, name: "Cost" })).toBeVisible();
  const panel = page.getByRole("region", { name: longDay(day(0)) });
  await browserExpect(panel.getByText("Today so far")).toBeVisible();
  await browserExpect(panel.getByTestId("day-cost")).toHaveText(/^\$[\d,.]+est\.$/i);
  await browserExpect(panel.getByRole("list", { name: "Costliest turns" }).getByRole("listitem").first()).toBeVisible();
  // The quota bar reads the newest sample: plan-wide windows only.
  const quota = page.locator("#study").getByRole("region", { name: "Plan usage" });
  await browserExpect(quota.getByText("61%")).toBeVisible();
  await browserExpect(quota.getByText("72%")).toHaveCount(0);
  // Over-counted days are drawn and labelled, and never the busiest.
  await browserExpect(page.getByText("over-counted (before #389)")).toBeVisible();

  const target = day(9);
  await page.locator(`[data-day="${target}"]`).click();
  await browserExpect(page).toHaveURL(new RegExp(`#study/cost/${target}$`));
  const picked = page.getByRole("region", { name: longDay(target) });
  await browserExpect(picked.getByText("That day")).toBeVisible();
  await browserExpect(page.locator(`[data-day="${target}"]`)).toHaveAttribute("aria-pressed", "true");
  const cost = await picked.getByTestId("day-cost").textContent();

  await page.reload();
  await browserExpect(page.getByRole("region", { name: longDay(target) }).getByTestId("day-cost")).toHaveText(cost!);
  await browserExpect(page.locator(`[data-day="${target}"]`)).toHaveAttribute("aria-pressed", "true");

  // The period cards follow the 7 / 30 day toggle.
  const who = page.getByRole("region", { name: "Who started it" });
  const week = await who.getByText(/turns\./).textContent();
  await who.getByRole("radio", { name: "30 days" }).click();
  await browserExpect(who.getByText(/turns\./)).not.toHaveText(week!);
  await browserExpect(page.getByRole("region", { name: "Scheduled jobs" }).getByText("Morning brief")).toBeVisible();

  // Busiest links to its day.
  await page.getByRole("region", { name: "At a glance" }).getByRole("button").click();
  await browserExpect(page).toHaveURL(/#study\/cost\/\d{4}-\d{2}-\d{2}$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/study-cost-desktop.png", fullPage: true });
});

it("an unknown or future day in the link opens on today", async () => {
  await boot({ days: 20, overcountedDays: 0 });
  const page = await open({ viewport: { width: 1280, height: 900 } }, `study/cost/${day(-3)}`);
  await browserExpect(page.getByRole("region", { name: longDay(day(0)) }).getByText("Today so far")).toBeVisible();
});

it("an empty ledger says nothing is recorded yet, with no quota bar", async () => {
  await boot(null);
  const page = await open({ viewport: { width: 1280, height: 900 } });
  await browserExpect(page.getByText("Nothing recorded yet")).toBeVisible();
  await browserExpect(page.locator("#study").getByRole("region", { name: "Plan usage" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/study-cost-empty.png" });
});

it("a ledger a few days old shows those days and leaves the rest of the calendar blank; on a phone too", async () => {
  await boot({ days: 3, overcountedDays: 0, limits: false });
  const page = await open({ ...devices["iPhone 14"], defaultBrowserType: undefined });
  await browserExpect(page.getByRole("region", { name: "Ten weeks" }).getByRole("button")).toHaveCount(3);
  await browserExpect(page.getByText(/^since /)).toBeVisible();
  await browserExpect(page.locator("#study").getByRole("region", { name: "Plan usage" })).toHaveCount(0);
  await browserExpect(page.getByText("over-counted (before #389)")).toHaveCount(0);
  await browserExpect(page.getByRole("region", { name: "At a glance" }).getByText("No fair comparison yet")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/study-cost-few-days-phone.png", fullPage: true });
});

it("looks right in both themes, on a desktop and a phone", async () => {
  await boot({});
  for (const [name, options] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await open({ ...options, colorScheme, reducedMotion: "reduce" });
      await browserExpect(page.getByRole("list", { name: "Costliest turns" })).toBeVisible();
      await browserExpect(page.getByRole("region", { name: "Scheduled jobs" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The Study scrolls inside its tab panel: grow the window to the whole page for the shot.
      const overflow = await page.evaluate(() => { const panel = document.querySelector("#study [role=tabpanel]")!; return panel.scrollHeight - panel.clientHeight; });
      await page.setViewportSize({ width: options.viewport.width, height: options.viewport.height + overflow + 8 });
      await page.screenshot({ path: `test-results/study-cost-${name}-${colorScheme}.png` });
      await page.close();
    }
  }
});

it("Tasks is its own category, and Sub-sessions shows every task's own turns plus the main conversation's for it", async () => {
  await boot({});
  for (const [name, options] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await open({ ...options, colorScheme, reducedMotion: "reduce" });
      const who = page.getByRole("region", { name: "Who started it" });
      await who.getByRole("radio", { name: "30 days" }).click();
      await browserExpect(who.getByRole("list", { name: "Cost by who started it" }).getByRole("listitem")).toHaveText([/^You/, /^Background/, /^Scheduled/, /^Tasks/]);
      const tasks = page.getByRole("region", { name: "Sub-sessions" });
      await browserExpect(tasks.getByTestId("cost-tasks-total")).toHaveText(/^\$[\d,.]+ in all: \$[\d,.]+ their own turns, \$[\d,.]+ the main conversation's for them$/);
      const rows = tasks.getByRole("list", { name: "Cost by sub-session" }).getByRole("listitem");
      await browserExpect(rows).toHaveCount(6);
      // A task with a report turn on the main conversation says how much of its total that was.
      await browserExpect(rows.filter({ hasText: "from the main conversation" }).first()).toBeVisible();
      // The old-style task (written as background) is read into Tasks too.
      await tasks.getByRole("button", { name: /^Show \d+ more$/ }).click();
      await browserExpect(rows).toHaveCount(9);
      // (Its relay row was "background" too, so it has no "from the main conversation" part: that is in the unattributed line.)
      await browserExpect(rows.filter({ hasText: /^s1\d+ turns?\$/ })).toHaveCount(1);
      await browserExpect(tasks.getByText(/were for several at once/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await tasks.scrollIntoViewIfNeeded();
      await tasks.screenshot({ path: `test-results/study-cost-tasks-${name}-${colorScheme}.png` });
      if (name === "desktop" && colorScheme === "light") {
        const overflow = await page.evaluate(() => { const panel = document.querySelector("#study [role=tabpanel]")!; return panel.scrollHeight - panel.clientHeight; });
        await page.setViewportSize({ width: 1280, height: 900 + overflow + 8 });
        await page.screenshot({ path: "test-results/study-cost-tasks-page-desktop-light.png" });
      }
      await page.close();
    }
  }
});
