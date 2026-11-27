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
  // Scrollbars as the owner's browser draws them (Playwright hides them by default): one that takes room must not
  // push the rail's content off centre.
  browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] }); page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  await browserExpect(row).toContainText("Fable 5.2");
  // As a turn that ends with a check-back scheduled and a background command still running leaves it.
  const moved = (agent.subsessions as unknown as { store: { transition: (id: string, e: string, o: object) => { ok: boolean } } })
    .store.transition("s1", "wait_external", { reason: "waiting for its scheduled check-back", expectFrom: ["active"] });
  expect(moved.ok).toBe(true);
  vi.spyOn(agent, "hasBackgroundWork").mockImplementation((key) => key === "task:s1");
  channel.publishSubsessionsChanged();
  await browserExpect(row).toContainText("Working (background)");
  await page.screenshot({ path: "test-results/subsessions-background.png" });
  await row.getByRole("button").click();
  await browserExpect(rail().getByTestId("subsession-state")).toContainText("Working (background)");
  await browserExpect(rail().locator('[data-subsession="s1"]').getByRole("heading")).toContainText("Fable 5.2");
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
  // The retry is on a timer (SUBSESSIONS_RETRY_MS for the list, and the chat's
  // own); the input can be enabled before it fires, so wait for the second read
  // rather than asserting it already happened.
  await expect.poll(() => listFails, { timeout: 12_000 }).toBeLessThan(0);
  await expect.poll(() => detailFails, { timeout: 12_000 }).toBeLessThan(0);
});

it("leads with what the task is doing until something is said, then folds it into one line above the chat that opens again", async () => {
  expect(agent.subsessions!.spawn("dm:owner", { title: "Fix the flaky test", brief: "Find why signals.e2e flakes and fix it." }).ok).toBe(true);
  expect(agent.subsessions!.setPlan("task:s1", [{ step: "Run it in a loop", status: "in_progress" }, { step: "Fix the wait" }, { step: "Open a PR" }],
    [{ step: "Read the test", result: "it races the first paint" }]).ok).toBe(true);
  agent.subsessions!.postUpdate("task:s1", "Chose to wait on the response, not a timer");
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await rail().locator('[data-subsession-row="s1"]').getByRole("button").click();
  const chat = rail().locator('[data-subsession="s1"]');

  // Nothing said yet: the plan and the updates have the view, under the brief, with no fold.
  const overview = chat.getByTestId("subsession-overview");
  await browserExpect(overview.getByTestId("subsession-doing")).toContainText("Run it in a loop");
  await browserExpect(overview.getByTestId("subsession-doing")).toContainText("Read the test");
  await browserExpect(overview.getByTestId("subsession-updates")).toContainText("Chose to wait on the response");
  await browserExpect(chat.getByTestId("subsession-progress")).toHaveCount(0);
  await page.screenshot({ path: "test-results/subsessions-progress-first.png" });

  // The task says something: the chat leads, and what it is doing is one line, the step it is on and how far through.
  await agent.subsessions!.reply("task:s1", "It races the first paint. Fixing the wait next.");
  await browserExpect(chat.locator('[data-from="task"]').filter({ hasText: "It races the first paint." })).toBeVisible();
  const fold = chat.getByTestId("subsession-progress");
  await browserExpect(fold.getByTestId("subsession-progress-summary")).toHaveText("Run it in a loop");
  await browserExpect(fold).toContainText("1/4");
  await browserExpect(overview).toHaveCount(0);
  await browserExpect(chat.getByTestId("subsession-doing")).toHaveCount(0);
  const trigger = fold.getByRole("button");
  await browserExpect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: "test-results/subsessions-chat-first.png" });

  // Opened in place, it shows the whole checklist and the updates; closed again, the chat has the room back.
  await trigger.click();
  await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
  await browserExpect(fold.getByTestId("subsession-doing")).toContainText("Open a PR");
  await browserExpect(fold.getByTestId("subsession-updates")).toContainText("Chose to wait on the response");
  await page.screenshot({ path: "test-results/subsessions-chat-first-open.png" });
  await trigger.click();
  await browserExpect(chat.getByTestId("subsession-doing")).toHaveCount(0);
  await browserExpect(chat.locator('[data-from="task"]').filter({ hasText: "It races the first paint." })).toBeVisible();
});

it("keeps the rail's content centred, gap for gap, and both input bars' placeholders on the bar's middle: light and dark, desktop and phone", async () => {
  expect(agent.subsessions!.spawn("dm:owner", { title: "Fix the flaky test", brief: "Find why signals.e2e flakes and fix it." }).ok).toBe(true);
  expect(agent.subsessions!.setPlan("task:s1", [{ step: "Run it in a loop", status: "in_progress" }, { step: "Fix the wait" }], [{ step: "Read the test" }]).ok).toBe(true);
  // Enough said that the chat scrolls: a scrollbar that takes room must not push the content off centre.
  for (let i = 0; i < 12; i++) await agent.subsessions!.reply("task:s1", `Line ${i}: it races the first paint, and the wait is on a timer, not the response.`);

  // A phone shows the rail as a dialog, not a complementary landmark.
  const panel = () => page.locator("#tasks-rail");
  /** How far `selector`'s box is from the rail's inner edges, left and right (the rail's border not counted). */
  const gaps = (selector: string) => page.evaluate((sel) => {
    const aside = document.getElementById("tasks-rail")!;
    const r = aside.getBoundingClientRect(); const inner = { left: r.left + aside.clientLeft, right: r.left + aside.clientLeft + aside.clientWidth };
    const box = document.querySelector(sel)!.getBoundingClientRect();
    return { left: box.left - inner.left, right: inner.right - box.right };
  }, selector);
  /** A field's placeholder line, centre to centre with its bar: the line box sits at the top of the content box. */
  const offCentre = (selector: string) => page.evaluate((sel) => {
    const field = document.querySelector<HTMLTextAreaElement>(sel)!;
    const style = getComputedStyle(field);
    const top = field.getBoundingClientRect().top + field.clientTop + parseFloat(style.paddingTop);
    const line = top + parseFloat(style.lineHeight) / 2;
    const bar = field.closest("form")!.getBoundingClientRect();
    return { empty: field.value === "", lineHeight: style.lineHeight, off: Math.abs(line - (bar.top + bar.height / 2)), bar: bar.height };
  }, selector);
  // Polled: the view slides in, and only once it has settled is a gap what it stays.
  const centred = async (selector: string) => {
    let last = { left: 0, right: 0 };
    await browserExpect.poll(async () => { last = await gaps(selector); return Math.abs(last.left - last.right); }, { message: `${selector} centred`, timeout: 3000 }).toBeLessThanOrEqual(1);
    expect(last.left).toBeGreaterThan(8);
  };
  const placeholderCentred = async (selector: string) => {
    const m = await offCentre(selector);
    expect(m.empty).toBe(true);
    expect(m.lineHeight).toMatch(/px$/);
    expect(m.off, `${selector}: ${JSON.stringify(m)}`).toBeLessThanOrEqual(1);
    return m.bar;
  };

  for (const { name, viewport } of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "phone", viewport: { width: 390, height: 844 } }]) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      // On a phone the rail covers the DM: close it to see the DM's bar.
      if (name === "phone" && await panel().isVisible()) { await panel().locator("[data-tasks-close]").click(); await browserExpect(panel()).toBeHidden(); }
      await browserExpect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
      // The DM's bar, empty, then focused: the placeholder on its middle, the bar shorter than it was (62px).
      await browserExpect(page.locator("#message")).toBeVisible();
      expect(await placeholderCentred("#message")).toBeLessThanOrEqual(52);
      await page.locator("#message").focus();
      await placeholderCentred("#message");
      await page.locator("form.composer").screenshot({ path: `test-results/composer-main-${name}-${scheme}.png` });

      if (!(await panel().isVisible())) await page.getByRole("button", { name: /^Tasks/ }).click();
      const chat = panel().locator('[data-subsession="s1"]');
      await browserExpect(panel().locator('[data-subsession="s1"], [data-subsession-row="s1"]').first()).toBeVisible();
      if (!(await chat.isVisible())) await panel().locator('[data-subsession-row="s1"]').getByRole("button").click();
      const fold = chat.getByTestId("subsession-progress");
      await browserExpect(fold).toBeVisible();
      await chat.getByTestId("subsession-scroll").evaluate((el) => { el.scrollTop = 0; });
      await browserExpect.poll(() => chat.getByTestId("subsession-scroll").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      // A scrollbar that takes room (Linux, Windows) sits in the rail's padding, not in the content.
      const bar = await chat.getByTestId("subsession-scroll").evaluate((el) => ({ width: el.offsetWidth - el.clientWidth, margin: getComputedStyle(el).marginRight }));
      console.log(`scrollbar ${name}/${scheme}: ${JSON.stringify(bar)}`);
      if (bar.width > 0) expect(bar.margin).toBe(`-${bar.width}px`);
      for (const sel of ['[data-subsession="s1"] [aria-label="Brief"]', "[data-testid=subsession-progress]", '[data-subsession="s1"] [data-from="task"]', '[data-subsession="s1"] form'])
        await centred(sel);
      // Opened, the checklist is centred too.
      const trigger = fold.getByRole("button").first();
      await trigger.click();
      await browserExpect(fold.getByTestId("subsession-doing")).toBeVisible();
      await centred("[data-testid=subsession-progress] [data-testid=subsession-doing]");
      await trigger.click();
      await browserExpect(fold.getByTestId("subsession-doing")).toHaveCount(0);
      // The rail's own bar, empty then focused.
      const input = chat.getByTestId("subsession-input");
      await input.blur();
      await placeholderCentred("[data-testid=subsession-input]");
      await input.focus();
      await placeholderCentred("[data-testid=subsession-input]");
      await page.screenshot({ path: `test-results/subsessions-layout-${name}-${scheme}.png` });
      // Back to the list: it is centred as well.
      await chat.getByRole("button", { name: "Back to tasks" }).click();
      await centred('[data-subsession-row="s1"]');
      await panel().locator('[data-subsession-row="s1"]').getByRole("button").click();
      await browserExpect(chat).toBeVisible();
    }
  }
}, 120_000);

it("Done on a task that needs the owner clears what its report asked, as `/s <id> done <report>` does", async () => {
  expect(agent.subsessions!.spawn("dm:owner", { title: "Ship 1.9", brief: "b" }).ok).toBe(true);
  // As task_finish leaves a second report that asks the owner to merge.
  const store = (agent.subsessions as unknown as { store: {
    transition: (id: string, e: string, o: object) => { ok: boolean };
    update: (id: string, fn: (r: Record<string, unknown>) => void) => unknown;
  } }).store;
  await browserExpect.poll(() => agent.subsessions!.get("s1")?.status).toBe("active");
  expect(store.transition("s1", "finish", { expectFrom: ["active"] }).ok).toBe(true);
  store.update("s1", (r) => { r.ownerAction = "Merge PR #3"; r.reportSeq = 2; });
  channel.publishSubsessionsChanged();
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const row = rail().locator('[data-subsession-row="s1"]');
  await browserExpect(row).toContainText("Needs you");
  await row.getByRole("button").click();
  await browserExpect(rail().getByTestId("subsession-state")).toContainText("Merge PR #3");
  await rail().getByRole("button", { name: "Done", exact: true }).click();
  await browserExpect.poll(() => agent.subsessions!.get("s1")!.ownerAction).toBeUndefined();
  await browserExpect(rail().getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await browserExpect(rail().getByTestId("subsession-state")).not.toContainText("Needs you");
});
