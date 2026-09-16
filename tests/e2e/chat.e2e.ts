import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, SessionStore, drainQueue, installAgentTestHooks, makeMsg, mockConfig, mockSdk } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { webSessionId } from "../../src/web/owner.js";
import { watchBus } from "../../src/watch/bus.js";
import { transcriptFileStem } from "../../src/sessions/store.js";

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
  agent = new Agent(); channel = new WebChannel(mockConfig.identities); provider = new MockChannel("telegram");
  supervisor = new WebSupervisor(channel, { ...mockConfig, port: 0 });
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

it("keeps private history locked without the access link", async () => {
  const anonymous = await browser.newPage();
  await anonymous.goto(url);
  await browserExpect(anonymous.getByText("Access link required", { exact: true })).toBeVisible();
  await browserExpect(anonymous.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await browserExpect(anonymous.getByRole("alert")).toContainText("Open the access link");
  await anonymous.close();
});

it("round-trips 16,000 CJK characters through the chat and transcript", async () => {
  const text = "中".repeat(16_000);
  mockSdk.responseFn = () => text;
  await page.getByRole("textbox", { name: "Message Tomo" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator(".message.assistant .markdown")).toHaveText(text);
  await page.reload();
  await browserExpect(page.locator(".message.user .markdown")).toHaveText(text);
  await browserExpect(page.locator(".message.assistant .markdown")).toHaveText(text);
  expect(mockSdk.promptsBySession).toHaveLength(1);
});

it("refreshes bootstrap after a definite CSRF rejection and retries the same request only once", async () => {
  const ids: string[] = []; let refreshes = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/bootstrap") refreshes++; });
  await page.route("**/api/v1/messages", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    if (ids.length > 1) { await route.continue(); return; }
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), "sec-fetch-site": "same-origin", origin: url, "x-tomo-csrf": "expired" } });
    expect(response.status()).toBe(403);
    await route.fulfill({ response });
  });
  mockSdk.responseFn = () => "Recovered once.";
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("After a long break");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.getByText("Recovered once.", { exact: true })).toBeVisible();
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(refreshes).toBe(1);
  expect(mockSdk.promptsBySession).toHaveLength(1);
});

it("explains oversized requests and preserves the draft", async () => {
  await page.route("**/api/v1/messages", (route) => route.fulfill({ status: 413, contentType: "application/json", body: '{"error":"body_too_large"}' }));
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("Keep this draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator(".feedback")).toContainText("Shorten it and send again");
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toHaveValue("Keep this draft");
  expect(mockSdk.promptsBySession).toHaveLength(0);
});

it("silently reloads the first history page after rotation invalidates a cursor", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const timestamp = Date.now();
  for (let i = 0; i < 110; i++) store.append("dm:owner", { role: "user", channel: "web", content: `Earlier message ${i}`, timestamp: timestamp + i });
  let firstPages = 0;
  page.on("response", (response) => {
    const value = new URL(response.url());
    if (value.pathname.endsWith("/messages") && !value.search) firstPages++;
  });
  await page.reload();
  // Wait for the initial snapshot's debounced refresh before introducing a
  // rotation. Otherwise that unrelated refresh can hide a broken 409 handler.
  await browserExpect.poll(() => firstPages).toBeGreaterThanOrEqual(2);
  await browserExpect(page.getByRole("button", { name: "Load earlier messages" })).toBeVisible();
  let staleStatus = 0;
  await page.route("**/messages?cursor=*", async (route) => {
    writeFileSync(resolve(mockConfig.sessionsDir, `${transcriptFileStem("dm:owner")}.legacy-20260916-000000.jsonl`), JSON.stringify({ role: "user", channel: "web", content: "History changed safely", timestamp: timestamp + 200 }) + "\n");
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), "sec-fetch-site": "same-origin" } });
    staleStatus = response.status(); await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await browserExpect(page.getByText("History changed safely", { exact: true })).toBeVisible();
  await browserExpect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(staleStatus).toBe(409);
});

it("chats over real HTTP/CSRF/IPC/SSE and preserves history, themes, accessibility and group read-only state", async () => {
  const errors: string[] = []; const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  mockSdk.responseFn = () => ["Here is a **clear starting point**.", "- [x] Read the brief\n- [ ] Write the first draft\n\n![remote](https://example.invalid/image.png)\n\n<script>window.pwned=true</script>\n\n[unsafe](javascript:alert(1))"];
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  await input.fill("Help me organize an idea."); await input.press("Enter");
  await browserExpect(page.getByText("clear starting point", { exact: true })).toBeVisible();
  await browserExpect(page.getByText("Reply in progress")).toHaveCount(0);
  await browserExpect(page.getByRole("checkbox", { name: "Completed task" })).toBeChecked();
  await browserExpect(page.getByRole("checkbox", { name: "Completed task" })).toBeDisabled();
  await browserExpect(page.getByText("5,000", { exact: false })).toBeVisible();
  expect(provider.delivered).toHaveLength(0);
  expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:owner"]);
  expect(requests.some((request) => new URL(request).hostname === "example.invalid")).toBe(false);
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  await browserExpect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.reload();
  await browserExpect(page.getByText("clear starting point", { exact: true })).toBeVisible();
  await browserExpect(page.getByText("Help me organize an idea.", { exact: true })).toHaveCount(1);
  await page.getByLabel("Color theme").selectOption("dark");
  await browserExpect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/chat-desktop-dark.png" });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByLabel("Color theme").selectOption("light");
  await browserExpect(input).toBeVisible(); await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/chat-tablet-light.png" });
  await page.getByLabel("Session", { exact: true }).selectOption(webSessionId("telegram:-1"));
  await browserExpect(page.getByText("A shared group note.", { exact: true })).toBeVisible();
  await browserExpect(input).toBeDisabled();
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.screenshot({ path: "test-results/group-tablet.png" });
  // Same-origin script still cannot send a group target through the real API.
  const status = await page.evaluate(async (targetId) => {
    const headers = { "x-tomo-request": "1" };
    const bootstrap = await (await fetch("/api/v1/bootstrap", { headers })).json();
    return (await fetch("/api/v1/messages", { method: "POST", headers: { ...headers, "content-type": "application/json", "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": bootstrap.epoch },
      body: JSON.stringify({ requestId: crypto.randomUUID(), targetId, text: "forged group write" }) })).status;
  }, webSessionId("telegram:-1"));
  expect(status).toBe(403);
  expect(mockSdk.promptsBySession).toHaveLength(1);
  expect(errors).toEqual([]);
});

it("preserves a draft after an uncertain response and does not automatically resubmit", async () => {
  mockSdk.responseFn = () => "The accepted reply.";
  let interceptedStatus = 0;
  await page.route("**/api/v1/messages", async (route) => {
    // Playwright's proxy fetch does not preserve browser-generated fetch
    // metadata; forward the original same-origin request explicitly.
    const response = await route.fetch({ headers: { ...await route.request().allHeaders(), "sec-fetch-site": "same-origin", origin: url } });
    interceptedStatus = response.status();
    await route.abort("connectionfailed");
  });
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("A single submission");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.getByRole("button", { name: "Check message status" })).toBeVisible();
  expect(interceptedStatus).toBe(202);
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toHaveValue("A single submission");
  await page.getByRole("button", { name: "Check message status" }).click();
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toHaveValue("");
  expect(mockSdk.promptsBySession).toHaveLength(1);
  await browserExpect(page.getByText("The accepted reply.", { exact: true })).toBeVisible();
});

it("keeps messaging operational when the optional web process dies", async () => {
  await supervisor.stop();
  await browserExpect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
  mockSdk.responseFn = () => "Provider remains available.";
  await provider.simulateMessage(makeMsg({ chatId: "test-owner", senderName: "Owner", text: "Provider request" }));
  await drainQueue(agent);
  expect(provider.delivered.map((message) => message.text)).toEqual(["Provider remains available."]);
  // All fixture files and browser captures stay under disposable test roots.
  expect(resolve(mockConfig.sessionsDir)).not.toContain("/.tomo/");
});
