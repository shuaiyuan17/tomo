/** Sub-sessions in the Tasks rail: their own group, and a chat with one inside the rail, beside the DM. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig, mockSdk, resetConfig } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";

installAgentTestHooks();
let agent: Agent;
let channel: WebChannel;
let supervisor: WebSupervisor;
let browser: Browser;
let page: Page;
beforeEach(async () => {
  watchBus.reset();
  resetConfig({ identities: [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }],
    subsessions: { ...mockConfig.subsessions, enabled: true }, tomoHome: mockConfig.tomoHome });
  agent = new Agent();
  channel = new WebChannel(mockConfig.owner, undefined, { subsessions: agent.webSubsessions() });
  supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0 });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(new MockChannel("telegram"));
  agent.onSubsessionsChanged(() => channel.publishSubsessionsChanged());
  await agent.start();
  // A task's turn never ends here: it stays active, "Working".
  mockSdk.responseFn = () => new Promise(() => {});
  await channel.start();
  browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // The page reads the list once it connects. Wait for that read to be answered: still in flight, the
  // daemon can answer it after a test's spawn (the `subsessions` event that follows is debounced 250 ms,
  // so this stale answer lands first), and a page.route the test installs meanwhile never sees it.
  const firstList = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/subsessions", { timeout: 10_000 });
  await Promise.all([firstList, (async () => {
    await page.goto(`http://127.0.0.1:${supervisor.status().port}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}`);
    await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  })()]);
});
afterEach(async () => { await browser?.close(); await agent.stop(); });

const rail = () => page.getByRole("complementary", { name: "Tasks" });

it("lists the owner's sub-sessions in their own group and opens one as a chat in the rail, beside the DM", async () => {
  expect(agent.subsessions!.spawn("dm:owner", { title: "Draft the release notes", brief: "Draft the 1.9 notes.", quote: ["start the 1.9 notes"] }).ok).toBe(true);
  // Another session's task never shows.
  expect(agent.subsessions!.spawn("telegram:-1", { title: "A group's task", brief: "x" }).ok).toBe(true);
  // The Tasks button counts the running task.
  await browserExpect(page.getByRole("button", { name: /^Tasks/ })).toContainText("1");
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const group = rail().getByTestId("subsessions");
  await browserExpect(group).toContainText("Sub-sessions");
  const row = group.locator('[data-subsession-row="s1"]');
  await browserExpect(row).toContainText("s1");
  await browserExpect(row).toContainText("Draft the release notes");
  await browserExpect(row).toContainText("Working");
  // The model its turns run on, as subagent rows show theirs: here the configured default.
  await browserExpect(row).toContainText("Sonnet 5");
  await browserExpect(rail()).not.toContainText("A group's task");
  await page.screenshot({ path: "test-results/subsessions-list.png" });

  await row.getByRole("button").click();
  const chat = rail().locator('[data-subsession="s1"]');
  await browserExpect(chat.getByRole("heading")).toContainText("Draft the release notes");
  await browserExpect(chat.getByRole("heading")).toContainText("Sonnet 5");
  await browserExpect(chat.getByLabel("Brief")).toContainText("start the 1.9 notes");
  // The DM stays on screen and usable beside it.
  await browserExpect(page.locator("#message")).toBeVisible();
  // Both input bars, empty, are the same height and share a bottom edge (composer-frame.ts).
  const bar = (field: string) => page.locator(field).evaluate((el) => { const r = el.closest("form")!.getBoundingClientRect(); return [Math.round(r.height), Math.round(r.bottom)]; });
  expect(await bar("[data-testid=subsession-input]")).toEqual(await bar("#message"));

  const input = chat.getByTestId("subsession-input");
  await input.fill("Lead with the web panel");
  await input.press("Enter");
  await browserExpect(chat.locator('[data-from="owner"]').filter({ hasText: "Lead with the web panel" })).toBeVisible();
  await browserExpect.poll(() => agent.subsessions!.get("s1")!.conversation.map((e) => `${e.from}:${e.text}`)).toEqual(["owner:Lead with the web panel"]);
  // It went to the task, not to the DM.
  await browserExpect(page.locator("main article").filter({ hasText: "Lead with the web panel" })).toHaveCount(0);

  // What the task says back shows up live.
  await agent.subsessions!.reply("task:s1", "Will do: it leads the notes.");
  await browserExpect(chat.locator('[data-from="task"]').filter({ hasText: "Will do: it leads the notes." })).toBeVisible();
  await page.screenshot({ path: "test-results/subsessions-chat.png" });

  await chat.getByRole("button", { name: "Back to tasks" }).click();
  await browserExpect(rail().getByTestId("subsessions")).toBeVisible();
});

it("shows a task's own model, and a task waiting on a check-back with background work still running as working", async () => {
  expect(agent.subsessions!.spawn("dm:owner", { title: "Long build", brief: "b", model: "fable" }).ok).toBe(true);
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const row = rail().locator('[data-subsession-row="s1"]');
  await browserExpect(row).toContainText("Fable 5.1");
  // As a turn that ends with a check-back scheduled and a background command still running leaves it.
  const moved = (agent.subsessions as unknown as { transition: (id: string, e: string, o: object) => { ok: boolean } })
    .transition("s1", "wait_external", { reason: "waiting for its scheduled check-back", expectFrom: ["active"] });
  expect(moved.ok).toBe(true);
  vi.spyOn(agent, "hasBackgroundWork").mockImplementation((key) => key === "task:s1");
  channel.publishSubsessionsChanged();
  await browserExpect(row).toContainText("Working (background)");
  await page.screenshot({ path: "test-results/subsessions-background.png" });
  await row.getByRole("button").click();
  await browserExpect(rail().getByTestId("subsession-state")).toContainText("Working (background)");
  await browserExpect(rail().locator('[data-subsession="s1"]').getByRole("heading")).toContainText("Fable 5.1");
});

it("an ended task reads, but cannot be written to", async () => {
  mockSdk.responseFn = () => "ok";
  agent.subsessions!.spawn("dm:owner", { title: "Old work", brief: "b" });
  await agent.subsessions!.cancel("s1", "test");
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const row = rail().locator('[data-subsession-row="s1"]');
  await browserExpect(row).toContainText("Cancelled");
  await row.getByRole("button").click();
  await browserExpect(rail().getByTestId("subsession-input")).toBeDisabled();
  await browserExpect(rail()).toContainText("This task has ended");
});

it("a failed read of the list or of a chat is tried again, and a table that is briefly unreadable is not taken for a task that is gone", async () => {
  let listFails = 1, detailFails = 1;
  await page.route("**/api/v1/subsessions", (route) => listFails-- > 0
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: false, tasks: [] }) }) : route.fallback());
  await page.route("**/api/v1/subsessions/s1", (route) => detailFails-- > 0
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "subsessions_unavailable" }) }) : route.fallback());
  agent.subsessions!.spawn("dm:owner", { title: "Retry me", brief: "b" });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const row = rail().locator('[data-subsession-row="s1"]');
  await browserExpect(row).toBeVisible({ timeout: 10_000 });
  await row.getByRole("button").click();
  const input = rail().getByTestId("subsession-input");
  await browserExpect(rail()).not.toContainText("no longer available");
  await browserExpect(input).toBeEnabled({ timeout: 10_000 });
  expect(listFails).toBeLessThan(0);
  expect(detailFails).toBeLessThan(0);
});
