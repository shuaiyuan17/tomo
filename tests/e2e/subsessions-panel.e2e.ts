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
  await page.goto(`http://127.0.0.1:${supervisor.status().port}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}`);
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
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
  await browserExpect(rail()).not.toContainText("A group's task");
  await page.screenshot({ path: "test-results/subsessions-list.png" });

  await row.getByRole("button").click();
  const chat = rail().locator('[data-subsession="s1"]');
  await browserExpect(chat.getByRole("heading")).toContainText("Draft the release notes");
  await browserExpect(chat.getByLabel("Brief")).toContainText("start the 1.9 notes");
  // The DM stays on screen and usable beside it.
  await browserExpect(page.locator("#message")).toBeVisible();

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
