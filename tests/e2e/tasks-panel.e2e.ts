/** The Tasks rail: how each kind of task is marked, the tree lines under a parent, and rows that leave. */
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
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
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

const task = (taskId: string, taskType: string, description: string, extra: Record<string, unknown> = {}) =>
  ({ taskId, taskType, description, ambient: false, background: true, startedAt: Date.now() - 10_000, ...extra });
const rail = () => page.getByRole("complementary", { name: "Tasks" });
const row = (name: RegExp) => rail().locator("li").filter({ has: page.getByRole("button", { name }) });

it("marks subagents with the trace's robot and shell tasks with its terminal; children hang off CSS tree lines", async () => {
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
    task("p1", "local_agent", "Review the release", { subagentType: "Explore" }),
    task("c1", "local_bash", "Rerun the codex review of #539 via stdin", { parentTaskId: "p1" }),
    task("c2", "local_bash", "cd /Users/alex/repo && npm test", { parentTaskId: "p1" }),
    task("m1", "monitor", "Watch the CI run"),
  ] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  // The same lucide icons the trace uses for an Agent call and a Bash call, hidden from screen readers.
  const agentIcon = row(/Review the release/).locator("[data-task-icon]");
  await browserExpect(agentIcon).toHaveAttribute("data-task-icon", "agent");
  await browserExpect(agentIcon).toHaveClass(/lucide-bot/);
  await browserExpect(agentIcon).toHaveAttribute("aria-hidden", "true");
  for (const name of [/npm test/, /Watch the CI run/]) {
    const icon = row(name).locator("[data-task-icon]");
    await browserExpect(icon).toHaveAttribute("data-task-icon", "shell");
    await browserExpect(icon).toHaveClass(/lucide-terminal/);
    await browserExpect(icon).toHaveAttribute("aria-hidden", "true");
  }
  // A description in words is the label, whole; a command line keeps its short name.
  await browserExpect(row(/Rerun the codex/).locator("[data-shell-label]")).toHaveText("Rerun the codex review of #539 via stdin");
  await browserExpect(row(/npm test/).locator("[data-shell-label]")).toHaveText("npm test");
  // Tree lines: the first child's line goes on to its sibling, the last one's stops at its elbow; top-level rows have none.
  const lines = (name: RegExp) => row(name).locator("[data-tree-lines] [data-tree-line]").evaluateAll((els) => els.map((el) => el.getAttribute("data-tree-line")));
  expect(await lines(/Rerun the codex/)).toEqual(["stem", "elbow"]);
  expect(await lines(/npm test/)).toEqual(["elbow"]);
  await browserExpect(row(/Review the release/).locator("[data-tree-lines]")).toHaveCount(0);
  await browserExpect(row(/Watch the CI run/).locator("[data-tree-lines]")).toHaveCount(0);
  await browserExpect(row(/Rerun the codex/).locator("[data-tree-lines]")).toHaveAttribute("aria-hidden", "true");
  // Drawn, not typed: no box-drawing characters in the list.
  expect(await rail().textContent()).not.toMatch(/[└├│]/);
  await page.screenshot({ path: "test-results/tasks-tree.png" });
});

it("a subagent that ended while a command it started still runs reads as working, not Done", async () => {
  const parentTask = task("p1", "local_agent", "UI demo subagent", { background: false, startedAt: Date.now() - 240_000 });
  const child = task("c1", "local_bash", "Sleep 60 seconds in background", { parentTaskId: "p1", startedAt: Date.now() - 60_000 });
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [parentTask, child] });
  // The subagent's own turn ends; the command it started runs on.
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [child], ended: [{ taskId: "p1", status: "completed" }] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const parent = row(/UI demo subagent/);
  await browserExpect(parent.getByTestId("task-children-running")).toBeVisible();
  await browserExpect(parent).toContainText("Working");
  await browserExpect(parent).not.toContainText("Done");
  await browserExpect(parent).toContainText("4m");
  await parent.screenshot({ path: "test-results/tasks-children-running.png" });
});

it("rows that left do not linger as invisible gaps when the rail re-renders mid-exit", async () => {
  const kids = (status?: string) => ["k1", "k2"].map((id) => task(id, "local_bash", `git status ${id}`, { parentTaskId: "p1", ...(status ? { status, endedAt: Date.now() } : {}) }));
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("p1", "local_agent", "Ship the attachments"), ...kids()] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await browserExpect(rail().getByRole("button", { name: /git status/ })).toHaveCount(2);
  // Both finish: their cards leave, folded into one "2 shell commands done" row. Any other update
  // re-renders the rail before their exit is over (the clock does every second).
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task("p1", "local_agent", "Ship the attachments"), ...kids("completed")] });
  await page.waitForTimeout(80);
  watchBus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [task("g1", "local_agent", "Group work")] });
  await browserExpect(rail()).toContainText("2 shell commands done");
  await page.waitForTimeout(600);
  await browserExpect(rail().locator("li.motion-exit")).toHaveCount(0);
});
