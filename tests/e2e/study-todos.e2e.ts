import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";
import { TodoStore } from "../../src/todos/store.js";
import { DEFAULT_TODOS } from "../../src/todos/limits.js";

installAgentTestHooks();
let agent: Agent;
let browser: Browser;
beforeEach(() => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  mkdirSync("test-results", { recursive: true });
});
afterEach(async () => { await browser?.close(); await agent?.stop(); });

it("the Study's Todos page shows the todo store: sections by who moves next, due first, the cap, links, and the done log", async () => {
  const dir = resolve(mockConfig.tomoHome, "data", "todos");
  const store = new TodoStore(dir, DEFAULT_TODOS);
  const day = 86_400_000; const now = Date.now();
  const add = (daysAgo: number, input: Record<string, unknown>) => store.add({ session: "dm:owner", source: "self", ...input } as Parameters<TodoStore["add"]>[0], now - daysAgo * day);
  const seeds = add(20, { title: "Order seeds", next: "Place the order", waiting_on: "me", review_in: "3d" });
  store.resolve(seeds.id, { action: "done", by: "self", evidence: "https://example.com/orders/1042" }, now - 9 * day);
  add(1, { title: "Build the trellis", next: "Pick a wall", waiting_on: "owner", review_in: "7d", ref: "memory/topics/garden.md" });
  add(9, { title: "Review the release PR", next: "Read the diff", waiting_on: "owner", review_in: "7d", ref: "https://github.com/example/garden/pull/41" });
  const tap = add(12, { title: "Call the plumber", next: "Phone before noon", waiting_on: "me", review_in: "2d" });
  for (const daysAgo of [10, 7, 4]) store.resolve(tap.id, { action: "snooze", by: "self", until: "3d", reason: "Line was busy." }, now - daysAgo * day);
  add(2, { title: "Upstream fix", next: "Watch the issue", waiting_on: "external", review_in: "14d" });
  const files = () => readdirSync(dir).sort().map((name) => [name, readFileSync(resolve(dir, name), "utf8")]);
  const before = files();

  agent = new Agent();
  const channel = new WebChannel(mockConfig.owner, undefined, { stop: (key) => agent.stopTurn(key) });
  const supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0, todoLimits: { maxOpen: 5, maxSnoozes: 3 } });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(new MockChannel("telegram"));
  await channel.start();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`http://127.0.0.1:${supervisor.status().port}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}#study/todos`);
  const study = page.locator("#study");
  await browserExpect(study.getByRole("heading", { level: 1, name: "Todos" })).toBeVisible();

  // The cap: 4 open of the configured 5 is close to it.
  await browserExpect(study.getByTestId("todo-open")).toHaveText("4 / 5");
  await browserExpect(study.getByText("1 left before", { exact: false })).toBeVisible();
  await browserExpect(study.getByTestId("todo-due")).toHaveText("2");

  // Sections in order, and inside one the due item above the one added later.
  await browserExpect(study.getByRole("heading", { level: 2 })).toHaveText(["Waiting on you", /^Waiting on /, "Waiting on others"]);
  const yours = study.getByRole("region", { name: "Waiting on you" }).getByRole("listitem");
  await browserExpect(yours).toHaveCount(2);
  await browserExpect(yours.nth(0)).toContainText("Review the release PR");
  await browserExpect(yours.nth(0)).toContainText("Due 2 days ago");
  await browserExpect(yours.nth(0)).toHaveAttribute("data-due", "true");
  await browserExpect(yours.nth(1)).toContainText("Build the trellis");
  await browserExpect(yours.nth(1)).not.toHaveAttribute("data-due", "true");

  // A PR ref is a link that opens elsewhere; a file path is not a link.
  const link = yours.nth(0).getByRole("link", { name: "example/garden#41" });
  await browserExpect(link).toHaveAttribute("href", "https://github.com/example/garden/pull/41");
  await browserExpect(link).toHaveAttribute("rel", "noopener noreferrer");
  await browserExpect(yours.nth(1).getByRole("link")).toHaveCount(0);
  await browserExpect(yours.nth(1)).toContainText("memory/topics/garden.md");

  // Snoozes against the limit, and the next step.
  const plumber = study.locator('[data-todo="t-4"]');
  await browserExpect(plumber).toContainText("Snoozed 3 of 3, none left: Line was busy.");
  await browserExpect(plumber).toContainText("Phone before noon");

  // The done log is folded until asked for.
  const recent = study.getByRole("region", { name: "Recently closed" });
  await browserExpect(recent.getByText("Order seeds")).toBeHidden();
  await recent.getByRole("button", { name: /Recently closed/ }).click();
  await browserExpect(recent.getByText("Order seeds")).toBeVisible();
  await browserExpect(recent.getByRole("link", { name: "example.com/orders/1042" })).toHaveAttribute("href", "https://example.com/orders/1042");

  // Read-only: nothing on the page writes, and viewing it left the store as it was.
  await browserExpect(study.getByRole("tabpanel").getByRole("button")).toHaveCount(1);
  await page.screenshot({ path: "test-results/study-todos-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await browserExpect(study.getByTestId("todo-open")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/study-todos-phone.png" });
  expect(files()).toEqual(before);
});
