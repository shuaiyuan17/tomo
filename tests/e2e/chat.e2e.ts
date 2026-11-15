import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";

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

it("one composer status follows a request to the end, then clears", async () => {
  mockSdk.responseFn = () => "Done.";
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("status check");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator("article.message.assistant").filter({ hasText: "Done." }).first()).toBeVisible();
  const status = page.locator(".feedback");
  await browserExpect(status).toHaveCount(1);
  await browserExpect(status).toHaveText("Completed");
  await browserExpect(page.getByText("Tomo is working…")).toHaveCount(0);
  await browserExpect(status).toHaveText("", { timeout: 5_000 });
});

it("the Tasks rail resizes from its edge: keyboard, drag (one resize on release), persisted, double-click resets", async () => {
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const rail = page.locator("#tasks-rail");
  await browserExpect(rail).toHaveAttribute("data-state", "open");
  const handle = page.getByRole("separator", { name: "Resize the Tasks panel" });
  await browserExpect(handle).toHaveAttribute("aria-valuenow", "300");
  await browserExpect(handle).toHaveAttribute("aria-valuemin", "280");
  await browserExpect(handle).toHaveAttribute("aria-valuemax", String(1440 - 272 - 480));
  const width = () => rail.evaluate((el) => Math.round(el.getBoundingClientRect().width));

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await browserExpect(handle).toHaveAttribute("aria-valuenow", "332");
  expect(await width()).toBe(332);

  // Drag: the rail keeps its width while the pointer moves, and takes the new one on release.
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(1440 - 500, box.y + 200, { steps: 5 });
  expect(await width()).toBe(332);
  await page.mouse.up();
  await browserExpect(handle).toHaveAttribute("aria-valuenow", "500");
  expect(await width()).toBe(500);

  await page.reload();
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await browserExpect(page.getByRole("separator", { name: "Resize the Tasks panel" })).toHaveAttribute("aria-valuenow", "500");
  expect(await width()).toBe(500);

  await page.getByRole("separator", { name: "Resize the Tasks panel" }).dblclick();
  await browserExpect(page.getByRole("separator", { name: "Resize the Tasks panel" })).toHaveAttribute("aria-valuenow", "300");
  expect(await width()).toBe(300);
  expect(await page.evaluate(() => localStorage.getItem("tomo.tasksRailWidth"))).toBeNull();
});

it("renders with blocked storage (reading localStorage throws), and the rail still resizes in memory", async () => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
  });
  await page.reload();
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const handle = page.getByRole("separator", { name: "Resize the Tasks panel" });
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await browserExpect(handle).toHaveAttribute("aria-valuenow", "316");
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
  const meter = page.getByRole("progressbar", { name: "Context tokens used" });
  await browserExpect(meter).toHaveAttribute("aria-valuenow", "5000");
  await browserExpect(meter).toHaveAttribute("aria-valuemax", "200000");
  expect(provider.delivered).toHaveLength(0);
  expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:owner"]);
  expect(requests.some((request) => new URL(request).hostname === "example.invalid")).toBe(false);
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  await browserExpect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.reload();
  await browserExpect(page.getByText("clear starting point", { exact: true })).toBeVisible();
  await browserExpect(page.getByText("Help me organize an idea.", { exact: true })).toHaveCount(1);
  await page.getByRole("radio", { name: "Dark theme" }).click();
  await browserExpect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/chat-desktop-dark.png" });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole("radio", { name: "Light theme" }).click();
  await browserExpect(input).toBeVisible(); await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/chat-tablet-light.png" });
  await page.getByRole("button", { name: /^Session/ }).click();
  await page.getByRole("menuitemradio", { name: /Test group/ }).click();
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

it("shows tasks in a pinnable rail; on narrow screens it is a keyboard-safe overlay", async () => {
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
    { taskId: "a1", taskType: "local_agent", subagentType: "Explore", description: "Map the repo", ambient: false, background: true, startedAt: Date.now(), summary: "Reading src/web" },
  ] });
  const toggle = page.getByRole("button", { name: /^Tasks, 1 running$/ });
  await browserExpect(toggle).toHaveAttribute("aria-pressed", "false");
  // Desktop: pinned rail, not modal, persisted across reloads.
  await toggle.click();
  await browserExpect(page.getByRole("complementary", { name: "Tasks" })).toContainText("Reading src/web");
  await browserExpect(page.locator("main#conversation")).not.toHaveAttribute("inert", "");
  await page.reload();
  await browserExpect(page.getByRole("complementary", { name: "Tasks" })).toBeVisible();
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await browserExpect(page.locator("#tasks-rail")).toHaveCount(0);
  // Narrow: overlay takes focus, traps it, Escape closes from anywhere and returns focus.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const dialog = page.getByRole("dialog", { name: "Tasks" });
  await browserExpect(dialog).toBeVisible();
  await browserExpect(page.getByRole("button", { name: "Close tasks" })).toBeFocused();
  await browserExpect(page.locator("main#conversation")).toHaveAttribute("inert", "");
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("#tasks-rail"))).toBe(true);
  }
  await page.getByRole("group", { name: "Task list" }).or(page.getByLabel("Task list")).first().focus();
  await browserExpect(page.getByLabel("Task list")).toBeFocused();
  await page.keyboard.press("Escape");
  await browserExpect(dialog).toHaveCount(0);
  await browserExpect(page.getByRole("button", { name: /^Tasks/ })).toBeFocused();
  await browserExpect(page.locator("main#conversation")).not.toHaveAttribute("inert", "");
});

it("the composer re-fits its height when only its width changes", async () => {
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  await input.fill("word ".repeat(45).trim());
  const wide = await input.evaluate((el) => el.getBoundingClientRect().height);
  await page.setViewportSize({ width: 390, height: 844 });
  await browserExpect.poll(() => input.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(wide);
  const narrow = await input.evaluate((el) => el.getBoundingClientRect().height);
  // Fits its content: no inner scrolling below the cap.
  expect(await input.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await browserExpect.poll(() => input.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(narrow);
});

it("opens a task to read its subagent transcript, expands a tool call, and goes back", async () => {
  const { mkdirSync: mkdir, writeFileSync: write } = await import("node:fs");
  new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).setSdkSessionId("dm:owner", "sdk-e2e");
  const dir = resolve(mockConfig.sdkSessionsDir, "sdk-e2e", "subagents");
  mkdir(dir, { recursive: true });
  const line = (type: string, content: unknown[]) => JSON.stringify({ type, message: { content } }) + "\n";
  write(resolve(dir, "agent-a1.jsonl"),
    line("user", [{ type: "text", text: "the hidden prompt" }]) +
    line("assistant", [{ type: "text", text: "Checking the release notes." }]) +
    line("assistant", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/CHANGELOG.md" } }]) +
    line("user", [{ type: "tool_result", tool_use_id: "t1", content: "## 0.12.0 entries" }]) +
    line("assistant", [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "owner" } }]) +
    line("user", [{ type: "tool_result", tool_use_id: "t2", content: "src/web/data.ts:24" }]) +
    JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "Also check the README.", origin: { kind: "coordinator" }, isMeta: true } }) + "\n" +
    JSON.stringify({ type: "api-request-blob", message: { role: "user", content: [{ type: "text", text: "Also check the README." }] } }) + "\n" +
    line("assistant", [{ type: "text", text: "Both look fine." }]));
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
    { taskId: "a1", taskType: "local_agent", subagentType: "Explore", description: "Review the release", ambient: false, background: true, startedAt: Date.now() },
  ] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await page.getByRole("button", { name: /Review the release/ }).click();
  const transcript = page.getByLabel("Subagent transcript");
  await browserExpect(transcript).toContainText("Checking the release notes.");
  // The prompt is the Brief, fixed above the transcript, and not repeated in it.
  await browserExpect(page.getByRole("region", { name: "Brief" })).toContainText("the hidden prompt");
  await browserExpect(transcript).not.toContainText("the hidden prompt");
  // Consecutive calls fold into one group; the narration around them stays visible.
  await browserExpect(transcript).toContainText("Both look fine.");
  // A message sent while it was busy (queued_command) shows once, as a message.
  await browserExpect(transcript.getByText("Also check the README.")).toHaveCount(1);
  await browserExpect(transcript).toContainText("Message from Tomo");
  await browserExpect(transcript.getByRole("button", { name: /Read \/repo\/CHANGELOG\.md/ })).toHaveCount(0);
  await transcript.getByRole("button", { name: /Read a file, ran a search/ }).click();
  await transcript.getByRole("button", { name: /Read \/repo\/CHANGELOG\.md/ }).click();
  await browserExpect(transcript).toContainText("## 0.12.0 entries");
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await browserExpect(page.getByRole("button", { name: /Review the release/ })).toBeVisible();
});

it("an Enter that confirms an IME candidate (Safari order) does not send", async () => {
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  await input.fill("ni hao");
  // Safari fires compositionend before the confirming Enter's keydown, which then has isComposing=false.
  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  expect(mockSdk.promptsBySession).toHaveLength(0);
  await browserExpect(input).toHaveValue("ni hao");
  // A later, ordinary Enter sends.
  mockSdk.responseFn = () => "Got it.";
  await input.press("Enter");
  await browserExpect(page.getByText("Got it.", { exact: true })).toBeVisible();
});

it("renders channel images as thumbnails (never the path), keeps line breaks, and shows reply quotes", async () => {
  const { mkdirSync: mkdir, writeFileSync: write } = await import("node:fs");
  const dir = resolve(mockConfig.workspaceDir, "memory", "incoming-images", "2026-11-14");
  mkdir(dir, { recursive: true });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const file = resolve(dir, "123533_telegram_test-owner_abcd1234.png");
  write(file, png);
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const t = Date.now();
  store.append("dm:owner", { role: "assistant", channel: "telegram", timestamp: t, content: "强哥的 #383 捡起来了，拆成了 3 个 PR，第一个已经合了" });
  store.append("dm:owner", { role: "user", channel: "telegram", timestamp: t + 1, content: `[Sent an image, saved to: ${file}] 像这样\n• one\n• two` });
  store.append("dm:owner", { role: "user", channel: "imessage", timestamp: t + 2, content: '[replying to: "强哥的 #383 捡起来了，拆成了 3 个 PR，…"] nicenice！！' });
  await page.reload();
  const image = page.getByRole("img", { name: "Image" });
  await image.evaluate((el) => el.scrollIntoView());
  // Served through the authenticated media endpoint and decoded (a 1×1 PNG).
  await browserExpect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
  expect(await image.evaluate(async (el: HTMLImageElement) => (await fetch(el.src)).headers.get("cache-control"))).toBe("no-store");
  await browserExpect(page.locator("main")).not.toContainText("incoming-images");
  await browserExpect(page.locator(".message.user .markdown").first()).toContainText("• one");
  expect(await page.locator(".message.user .markdown br").count()).toBeGreaterThanOrEqual(2);
  const quote = page.getByRole("button", { name: /Replying to/ });
  await browserExpect(quote).toContainText("强哥的 #383");
  await browserExpect(page.getByText("nicenice！！")).toBeVisible();
  await browserExpect(page.locator("main")).not.toContainText("[replying to");
  await quote.click();
  await browserExpect(page.locator("article.message.assistant").filter({ hasText: "第一个已经合了" })).toHaveClass(/bg-primary/);
  await image.click();
  await browserExpect(page.getByRole("dialog", { name: "Image" })).toBeVisible();
  // The overlay covers the window: no row or scroller contains it (paint/layout containment would).
  expect(await page.getByRole("dialog", { name: "Image" }).evaluate((el) => { const r = el.getBoundingClientRect(); return [r.width === innerWidth, r.height === innerHeight]; })).toEqual([true, true]);
  await page.keyboard.press("Escape");
  await browserExpect(page.getByRole("dialog", { name: "Image" })).toHaveCount(0);
});

it("shows the Plan usage card with a named state and a refresh button", async () => {
  const card = page.getByRole("region", { name: /Plan usage/ });
  await browserExpect(card).toContainText("Usage isn't available here.");
  await card.getByRole("button", { name: "Refresh plan usage" }).click();
  await browserExpect(card).toContainText("Not updated yet");
});

it("asks Tomo to compact from the context card, after a confirm; greyed out while tasks run", async () => {
  mockSdk.responseFn = () => "NO_REPLY";
  const button = page.getByRole("button", { name: "Compact context" });
  await browserExpect(button).toBeEnabled();
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [{ taskId: "a1", taskType: "local_agent", description: "x", ambient: false, background: true, startedAt: Date.now() }] });
  await browserExpect(page.getByRole("button", { name: "1 task running — wait for it to finish" })).toBeDisabled();
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [] });
  await page.getByRole("button", { name: "Compact context" }).click();
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await browserExpect.poll(() => mockSdk.promptsBySession.length).toBe(1);
  // The turn finished but the mock's context did not drop: reported as unverified, never as "Compacted".
  await browserExpect(page.getByText(/may have skipped/)).toBeVisible();
  await browserExpect(page.getByText("Compacted")).toHaveCount(0);
  expect(mockSdk.promptsBySession[0].sessionKey).toBe("dm:owner");
  expect(JSON.stringify(mockSdk.promptsBySession[0])).toContain("The owner requested a compact from the web UI.");
  expect(provider.delivered).toHaveLength(0);
});

it("refuses a compact request from an earlier daemon epoch (real supervisor epoch check)", async () => {
  const result = await page.evaluate(async () => {
    const headers = { "x-tomo-request": "1" };
    const bootstrap = await (await fetch("/api/v1/bootstrap", { headers })).json();
    const res = await fetch("/api/v1/compact-request", { method: "POST", headers: { ...headers, "content-type": "application/json",
      "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": crypto.randomUUID() }, body: "{}" });
    return [res.status, (await res.json()).error];
  });
  expect(result).toEqual([409, "epoch_changed"]);
  expect(mockSdk.promptsBySession).toHaveLength(0);
});

it("motion: new messages rise in, the rail transitions open and closed, and reduced motion turns it all off", async () => {
  mockSdk.responseFn = () => "A fresh reply.";
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  await input.fill("hello"); await input.press("Enter");
  const reply = page.locator("article.message.assistant").filter({ hasText: "A fresh reply." }).first();
  await browserExpect(reply).toBeVisible();
  // The rail opens with a transition and is gone after closing.
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await browserExpect(page.locator("#tasks-rail")).toHaveAttribute("data-state", "open");
  // Wide screens: the rail's own box never animates (the chat would reflow every frame); its content slides.
  const rail = await page.locator("#tasks-rail").evaluate((el) => [getComputedStyle(el).transitionProperty, getComputedStyle(el.firstElementChild!).transitionProperty]);
  expect(rail[0]).not.toMatch(/width|padding/);
  expect(rail[1]).toMatch(/opacity/);
  await page.getByRole("button", { name: "Close tasks" }).click();
  await browserExpect(page.locator("#tasks-rail")).toHaveCount(0);
  // With reduced motion, no animation or transition runs.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const style = await page.evaluate(() => {
    const el = document.createElement("div"); el.className = "motion-enter transition-colors"; document.body.append(el);
    const cs = getComputedStyle(el); const out = [cs.animationName, cs.transitionDuration]; el.remove(); return out;
  });
  expect(style).toEqual(["none", "0s"]);
});

it("a picture the agent sends (MEDIA:<path>) shows as a thumbnail by id, never as its path; an unfiled one is a placeholder", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "tomo-e2e-out-"));
  const file = resolve(dir, "gap.png");
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).append("dm:owner",
    { role: "assistant", channel: "imessage", timestamp: Date.now() - 1_000, content: "From before:\nMEDIA:/tmp/long-gone.jpg" });
  mockSdk.responseFn = () => `Here is the gap.\nMEDIA:${file}`;
  await page.reload();
  await browserExpect(page.getByText("Image (no longer available)")).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("Show me the gap");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const image = page.locator("article.message.assistant").filter({ hasText: "Here is the gap." }).getByRole("img", { name: "Image" });
  await browserExpect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth).catch(() => 0)).toBe(1);
  expect(await image.evaluate((el: HTMLImageElement) => new URL(el.src).pathname)).toMatch(/\/outgoing\/[a-f0-9]{32}$/);
  // Recorded and reloaded: the same picture, from the store (the source can go).
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
  await page.reload();
  const recorded = page.locator("article.message.assistant").filter({ hasText: "Here is the gap." }).getByRole("img", { name: "Image" });
  await browserExpect.poll(() => recorded.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth).catch(() => 0)).toBe(1);
  await browserExpect(page.locator("main")).not.toContainText("MEDIA:");
  expect(await page.content()).not.toContain("gap.png");
  expect(await page.content()).not.toContain("long-gone");
});

it("calls the agent by its IDENTITY.md name (re-read on edit); the product keeps its own name", async () => {
  mkdirSync(mockConfig.workspaceDir, { recursive: true });
  writeFileSync(resolve(mockConfig.workspaceDir, "IDENTITY.md"), "# IDENTITY.md - Who Am I?\n\n- **Name:** Claw\n- **Vibe:** direct\n");
  new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).append("dm:owner", { role: "assistant", channel: "web", content: "Hello there.", timestamp: Date.now() });
  await page.reload();
  await browserExpect(page.getByRole("textbox", { name: "Message Claw" })).toBeVisible();
  await browserExpect(page.locator("article.message.assistant").first()).toContainText("Claw");
  await browserExpect(page.locator("article.message.assistant").first()).not.toContainText("Tomo");
  await browserExpect(page.getByRole("link", { name: "Tomo home" })).toBeVisible();
  expect(await page.title()).toMatch(/Tomo/i);
  writeFileSync(resolve(mockConfig.workspaceDir, "IDENTITY.md"), "- **名字：** 小爪\n");
  const { utimesSync } = await import("node:fs");
  utimesSync(resolve(mockConfig.workspaceDir, "IDENTITY.md"), new Date(), new Date(Date.now() + 5_000));
  await page.reload();
  await browserExpect(page.getByRole("textbox", { name: "Message 小爪" })).toBeVisible();
  const { rmSync } = await import("node:fs");
  rmSync(resolve(mockConfig.workspaceDir, "IDENTITY.md"), { force: true });
});

it("shows a turn's tool calls inline, folded, between the messages; INPUT/OUTPUT open on demand", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  store.setSdkSessionId("dm:owner", "sdk-inline");
  const t = Date.now() - 60_000;
  store.append("dm:owner", { role: "user", channel: "web", content: "Check the changelog please.", timestamp: t });
  store.append("dm:owner", { role: "assistant", channel: "web", content: "The changelog is fine.", timestamp: t + 5_000 });
  const line = (type: string, ms: number, content: unknown[]) => JSON.stringify({ type, isSidechain: false, timestamp: new Date(ms).toISOString(), message: { role: type, content } }) + "\n";
  mkdirSync(mockConfig.sdkSessionsDir, { recursive: true });
  writeFileSync(resolve(mockConfig.sdkSessionsDir, "sdk-inline.jsonl"),
    line("user", t + 100, [{ type: "text", text: "Check the changelog please." }]) +
    line("assistant", t + 1_000, [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/repo/CHANGELOG.md" } }]) +
    line("user", t + 1_100, [{ type: "tool_result", tool_use_id: "c1", content: "## 0.12.0 entries" }]) +
    line("assistant", t + 2_000, [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "GH_TOKEN=supersecret gh pr list" } }]) +
    line("user", t + 2_100, [{ type: "tool_result", tool_use_id: "c2", content: "#1 open" }]) +
    line("assistant", t + 3_000, [{ type: "tool_use", id: "c3", name: "Bash", input: { command: "git status", description: "Check the working tree" } }]) +
    line("user", t + 3_100, [{ type: "tool_result", tool_use_id: "c3", content: "clean" }]));
  await page.reload();
  const history = page.getByLabel("Conversation history");
  const summary = history.getByRole("button", { name: "Read a file, ran 2 commands" });
  await browserExpect(summary).toBeVisible();
  // Collapsed by default, between the request and the reply; the reply text is never folded.
  expect(await summary.evaluate((el) => {
    const all = [...document.querySelectorAll("#conversation article, #conversation [data-slot=trace-collapsible]")];
    const index = all.indexOf(el.closest("[data-slot=trace-collapsible]")!);
    return [all[index - 1]?.textContent?.includes("Check the changelog"), all[index + 1]?.textContent?.includes("The changelog is fine.")];
  })).toEqual([true, true]);
  await browserExpect(summary).toHaveAttribute("aria-expanded", "false");
  await browserExpect(history.getByText("## 0.12.0 entries")).toHaveCount(0);
  await summary.click();
  const read = history.getByRole("button", { name: /Read \/repo\/CHANGELOG\.md/ });
  await read.click();
  await browserExpect(history).toContainText("## 0.12.0 entries");
  // #492's redaction runs on the server: the secret never reaches the page.
  await history.getByRole("button", { name: /gh pr list/ }).click();
  await browserExpect(history).toContainText("GH_TOKEN=•••");
  expect(await page.content()).not.toContain("supersecret");
  // A command the model described is titled by that description; the command itself is inside.
  await browserExpect(history.getByText("git status")).toHaveCount(0);
  await history.getByRole("button", { name: "Check the working tree" }).click();
  await browserExpect(history).toContainText("git status");
  await page.screenshot({ path: "test-results/inline-tools-desktop.png" });
  // No separate "Bash · completed" line above the composer.
  watchBus.publish({ type: "tool.end", ts: Date.now(), sessionKey: "dm:owner", tool: "Bash", ok: true } as never);
  await page.waitForTimeout(300);
  await browserExpect(page.getByText("Bash · completed")).toHaveCount(0);
});

it("a jump-to-latest pill: shown a screen up, counts new messages without pulling the reader down, jumps on click", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const t = Date.now() - 600_000;
  for (let i = 0; i < 40; i++) store.append("dm:owner", { role: i % 2 ? "assistant" : "user", channel: "web", content: `Line ${i}\n\nmore text to make it tall`, timestamp: t + i * 1_000 });
  await page.reload();
  const history = page.getByLabel("Conversation history");
  await browserExpect(history).toContainText("Line 39");
  await browserExpect(page.getByRole("button", { name: /jump to latest/i })).toHaveCount(0);
  // The reader scrolls up (a wheel: the scroller stops following on the reader's own scroll).
  await history.hover();
  await page.mouse.wheel(0, -100_000);
  const pill = page.getByRole("button", { name: "Jump to latest" });
  await browserExpect(pill).toBeVisible();
  const top = await history.evaluate((el) => el.scrollTop);
  store.append("dm:owner", { role: "assistant", channel: "telegram", content: "A new reply arrived.", timestamp: Date.now() });
  watchBus.publish({ type: "transcript", ts: Date.now(), sessionKey: "dm:owner", role: "assistant", channel: "telegram", text: "x" });
  await browserExpect(page.getByRole("button", { name: "1 new message, jump to latest" })).toBeVisible();
  expect(await history.evaluate((el) => el.scrollTop)).toBe(top);
  // A new turn from another channel (a user message: a scroll anchor) does not pull the reader to it either.
  store.append("dm:owner", { role: "user", channel: "telegram", content: "Asked from the phone.", timestamp: Date.now() + 1 });
  watchBus.publish({ type: "transcript", ts: Date.now(), sessionKey: "dm:owner", role: "user", channel: "telegram", text: "x" });
  await browserExpect(page.getByRole("button", { name: "2 new messages, jump to latest" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(top);
  await page.getByRole("button", { name: "2 new messages, jump to latest" }).focus();
  await page.keyboard.press("Enter");
  await browserExpect.poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);
  await browserExpect(page.getByRole("button", { name: /jump to latest/i })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Conversation history");
  // Back at the end, the view follows what arrives.
  store.append("dm:owner", { role: "assistant", channel: "telegram", content: `Followed.\n\n${"A tall reply line.\n\n".repeat(30)}`, timestamp: Date.now() + 2 });
  watchBus.publish({ type: "transcript", ts: Date.now(), sessionKey: "dm:owner", role: "assistant", channel: "telegram", text: "x" });
  await browserExpect(history).toContainText("Followed.");
  await browserExpect.poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await browserExpect(page.getByRole("button", { name: /jump to latest/i })).toHaveCount(0);
});

/** A row's top, relative to the conversation's viewport (Infinity for one just replaced, so a poll retries). */
const topOf = (row: ReturnType<Page["locator"]>) => row.evaluate((el) => {
  const view = el.closest("[aria-label='Conversation history']");
  return view ? Math.round(el.getBoundingClientRect().top - view.getBoundingClientRect().top) : Infinity;
});
const tall = (i: number) => `Reply ${i}.\n\n${"A paragraph of the reply, long enough to give the conversation some height on any screen.\n\n".repeat(16)}`;

/** A solid PNG of the given size (a real one: the upload sniffs it). */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 0x88); row[0] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

it("opens at the last turn; a sent message (a tall picture too) is just fully shown, no screen of blank under it, and the reply is followed while the reader stays at the end", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const t = Date.now() - 600_000;
  for (let i = 0; i < 30; i++) store.append("dm:owner", { role: i % 2 ? "assistant" : "user", channel: "web", content: i % 2 ? tall(i) : `Question ${i}?`, timestamp: t + i * 1_000 });
  await page.addInitScript(() => {
    const w = window as unknown as { cspViolations: string[] };
    w.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => w.cspViolations.push(event.violatedDirective));
  });
  await page.reload();
  const history = page.getByLabel("Conversation history");
  const last = page.locator("article.message.user").filter({ hasText: "Question 28?" });
  await browserExpect(last).toBeVisible();
  // Not the absolute end: the last question, with its (taller than the screen) answer below it.
  await browserExpect.poll(() => topOf(last)).toBeGreaterThan(40);
  expect(await topOf(last)).toBeLessThan(100);
  expect(await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
  // The previous row peeks in above it.
  expect(await page.locator("article.message.assistant").filter({ hasText: "Reply 27." }).evaluate((el) =>
    el.getBoundingClientRect().bottom > el.closest("[aria-label='Conversation history']")!.getBoundingClientRect().top)).toBe(true);
  await page.screenshot({ path: "test-results/chat-opened-at-last-turn.png" });
  // Dragging the scrollbar (a pointer on the viewport itself, then a scroll) lets go of the turn too:
  // a row growing afterwards does not snap the reader back to it.
  await history.evaluate((el) => { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); el.scrollTop -= 300; });
  await page.waitForTimeout(200);
  const dragged = await history.evaluate((el) => el.scrollTop);
  await history.evaluate((el) => {
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    const block = document.createElement("div"); block.style.height = "100px"; [...el.querySelectorAll("article.message")].at(-1)!.append(block);
  });
  await page.waitForTimeout(300);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(dragged);

  const gap = () => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  /** How far a row's bottom sits above the viewport's (negative: cut off), and whether its top is in view. */
  const fit = (row: ReturnType<Page["locator"]>) => row.evaluate((el) => {
    const view = el.closest("[aria-label='Conversation history']")!.getBoundingClientRect(), box = el.getBoundingClientRect();
    return { below: Math.round(view.bottom - box.bottom), topIn: box.top >= view.top - 1 };
  });
  const spacer = () => history.evaluate((el) => { const s = el.querySelector<HTMLElement>("[data-message-scroller-spacer]"); return s && !s.hidden ? s.offsetHeight : 0; });

  // Sent from a screen up, with a tall picture and no reply yet: the view goes
  // to the end, just far enough to show the whole message; nothing reserved under it.
  let release!: (text: string) => void;
  mockSdk.responseFn = () => new Promise<string>((r) => { release = r; });
  await page.locator("input[type=file]").setInputFiles([{ name: "tall.png", mimeType: "image/png", buffer: solidPng(200, 900) }]);
  await browserExpect(page.getByRole("listitem", { name: "tall.png, attached" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("The next question");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = page.locator("article.message.user").filter({ hasText: "The next question" });
  await browserExpect(sent.getByRole("img")).toBeVisible();
  await browserExpect.poll(gap).toBeLessThan(2);
  await browserExpect.poll(async () => (await fit(sent)).below).toBeGreaterThanOrEqual(0);
  expect((await fit(sent)).below).toBeLessThan(60);
  expect((await fit(sent)).topIn).toBe(true);
  expect(await spacer()).toBe(0);
  await page.screenshot({ path: "test-results/chat-just-sent.png" });
  // A picture that loads late (0px, then its height) in the last row: the end stays in view, not cut off.
  await page.route("**/late-picture.png", async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.fulfill({ contentType: "image/png", body: solidPng(200, 600) }); });
  await sent.evaluate((el) => { const img = document.createElement("img"); img.src = "/late-picture.png"; img.style.display = "block"; img.style.maxHeight = "200px"; el.append(img); });
  await browserExpect.poll(() => sent.evaluate((el) => el.querySelector<HTMLImageElement>("img[src='/late-picture.png']")!.offsetHeight)).toBe(200);
  await browserExpect.poll(gap).toBeLessThan(2);
  expect((await fit(sent)).below).toBeGreaterThanOrEqual(0);
  // A short answer: right under the question, and the view ends at it.
  release("A short answer.\n\nIn two paragraphs.");
  const reply = page.locator("article.message.assistant").filter({ hasText: "In two paragraphs." });
  await browserExpect(reply).toBeVisible();
  await browserExpect.poll(gap).toBeLessThan(2);
  expect((await fit(reply)).below).toBeGreaterThanOrEqual(0);
  expect((await fit(reply)).below).toBeLessThan(60);
  expect(await spacer()).toBe(0);

  // A reply that streams past the screen: the view follows its end, block by block.
  mockSdk.responseFn = () => new Promise<string>((r) => { release = r; });
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("Now a long one");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator("article.message.user").filter({ hasText: "Now a long one" })).toBeVisible();
  await browserExpect.poll(gap).toBeLessThan(2);
  const sdk = mockSdk.queryControllers.at(-1)!;
  for (const i of [100, 101, 102]) {
    sdk.pushEvent({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: tall(i) }] } });
    await browserExpect(history).toContainText(`Reply ${i}.`);
    await browserExpect.poll(gap).toBeLessThan(2);
  }
  // The reader scrolls up (past the start of the reply): what streams in next leaves them there, and the pill offers the way back.
  await history.hover();
  await page.mouse.wheel(0, -8_000);
  await page.waitForTimeout(300);
  const reading = await history.evaluate((el) => el.scrollTop);
  sdk.pushEvent({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: tall(103) }] } });
  await browserExpect(history).toContainText("Reply 103.");
  await page.waitForTimeout(300);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(reading);
  expect(await gap()).toBeGreaterThan(400);
  await browserExpect(page.getByRole("button", { name: /jump to latest/i })).toBeVisible();
  release("The end of it.");
  await browserExpect(page.locator("article.message.assistant").filter({ hasText: "The end of it." })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await history.evaluate((el) => el.scrollTop)).toBe(reading);
  await page.getByRole("button", { name: /jump to latest/i }).click();
  await browserExpect.poll(gap).toBeLessThan(2);
  // The scroller sets its spacer through the DOM: no <style> element, nothing the CSP refused.
  expect(await page.evaluate(() => [document.querySelectorAll("style").length, (window as unknown as { cspViolations: string[] }).cspViolations])).toEqual([0, []]);
});

it("Load earlier keeps the reader's place, and a row growing above the view does not move it", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const t = Date.now() - 600_000;
  for (let i = 0; i < 130; i++) store.append("dm:owner", { role: i % 2 ? "assistant" : "user", channel: "web", content: `Message ${i}\n\nwith a second paragraph`, timestamp: t + i * 1_000 });
  await page.reload();
  const history = page.getByLabel("Conversation history");
  const earlier = page.getByRole("button", { name: "Load earlier messages" });
  await browserExpect(earlier).toBeVisible();
  await history.hover();
  await browserExpect.poll(async () => { await page.mouse.wheel(0, -20_000); return history.evaluate((el) => el.scrollTop); }).toBe(0);
  const firstRow = () => history.evaluate((el) => {
    const view = el.getBoundingClientRect();
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find((r) => r.getBoundingClientRect().bottom > view.top)!;
    return { id: row.dataset.messageId!, top: Math.round(row.getBoundingClientRect().top - view.top) };
  });
  const before = await firstRow();
  await earlier.click();
  await browserExpect(history).toContainText("Message 0");
  await page.waitForTimeout(300);
  const row = history.locator(`[data-message-id="${before.id}"]`);
  expect(Math.abs(await topOf(row) - before.top)).toBeLessThanOrEqual(1);
  // A picture loading (here: a row growing by 400px) above the view leaves the reader where they are.
  const reading = await firstRow();
  await history.evaluate((el) => {
    const view = el.getBoundingClientRect();
    const above = [...el.querySelectorAll("article.message")].filter((a) => a.getBoundingClientRect().bottom < view.top).at(-1)!;
    const block = document.createElement("div"); block.style.height = "400px"; above.append(block);
  });
  await page.waitForTimeout(300);
  expect(Math.abs(await topOf(history.locator(`[data-message-id="${reading.id}"]`)) - reading.top)).toBeLessThanOrEqual(1);
});

it("a reply's quote jumps to the quoted message far up and flashes it; focus stays in the conversation", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const t = Date.now() - 600_000;
  store.append("dm:owner", { role: "assistant", channel: "imessage", content: "The original note, far up.", timestamp: t });
  for (let i = 1; i < 40; i++) store.append("dm:owner", { role: i % 2 ? "user" : "assistant", channel: "web", content: `Line ${i}\n\nmore text to make it tall`, timestamp: t + i * 1_000 });
  store.append("dm:owner", { role: "user", channel: "imessage", content: '[replying to: "The original note, far up."] this one', timestamp: t + 50_000 });
  await page.reload();
  const original = page.locator("article.message.assistant").filter({ hasText: "The original note, far up." });
  await browserExpect(page.getByText("this one", { exact: true })).toBeVisible();
  await browserExpect(original).not.toBeInViewport();
  await page.getByRole("button", { name: /Replying to/ }).click();
  await browserExpect(original).toBeInViewport();
  await browserExpect(original).toHaveClass(/bg-primary/);
  expect(await page.evaluate(() => !!document.activeElement?.closest("[aria-label='Conversation history']"))).toBe(true);
});

it("attaches images by button, drop and paste; shows the tray with ×; sends an image alone; it reaches the model and incoming-images", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  mockSdk.responseFn = () => "Got the picture.";
  await page.locator("input[type=file]").setInputFiles([{ name: "one.png", mimeType: "image/png", buffer: png }]);
  const tray = page.getByRole("list", { name: "Attached images" });
  await browserExpect(tray.getByRole("listitem", { name: "one.png, attached" })).toBeVisible();
  // Drag files over the chat: "Drop to attach"; dropping adds them.
  const drop = async (type: "dragenter" | "drop") => page.locator("#conversation").evaluate((el, [kind, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "two.png", { type: "image/png" }));
    el.dispatchEvent(new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [type, png.toString("base64")] as const);
  await drop("dragenter");
  await browserExpect(page.getByText("Drop to attach")).toBeVisible();
  await drop("drop");
  await browserExpect(page.getByText("Drop to attach")).toHaveCount(0);
  await browserExpect(tray.getByRole("listitem", { name: "two.png, attached" })).toBeVisible();
  // Paste an image into the composer.
  await page.getByRole("textbox", { name: "Message Tomo" }).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "three.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  await browserExpect(tray.getByRole("listitem")).toHaveCount(3);
  await tray.getByRole("button", { name: "Remove three.png" }).click();
  await browserExpect(tray.getByRole("listitem")).toHaveCount(2);
  // A fake image (an SVG named .png) is refused by the server: the tray says so and offers a retry.
  await page.locator("input[type=file]").setInputFiles([{ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") }]);
  await browserExpect(tray.getByRole("listitem", { name: "evil.png, upload failed" })).toBeVisible();
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await tray.getByRole("button", { name: "Remove evil.png" }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator(".message.assistant .markdown").last()).toHaveText("Got the picture.");
  await browserExpect(tray).toHaveCount(0);
  const blocks = mockSdk.userContents.at(-1) as Array<{ type: string }>;
  expect(blocks.filter((block) => block.type === "image")).toHaveLength(2);
  const { readdirSync } = await import("node:fs");
  const filed = readdirSync(resolve(mockConfig.workspaceDir, "memory", "incoming-images"), { recursive: true }).map(String).filter((name) => name.endsWith(".png"));
  expect(filed.filter((name) => /_web_owner_/.test(name))).toHaveLength(2);
  expect(readdirSync(uploadsDir(mockConfig.tomoHome))).toEqual([]);
  // Recorded: the bubble shows thumbnails, not the path.
  await page.reload();
  await browserExpect(page.locator(".message.user").last().getByRole("img", { name: "Image" })).toHaveCount(2);
  await browserExpect(page.locator("main")).not.toContainText("incoming-images");
});

it("an image pasted while a message is sending stays in the tray for the next one", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  mockSdk.responseFn = () => "Seen.";
  const tray = page.getByRole("list", { name: "Attached images" });
  await page.locator("input[type=file]").setInputFiles([{ name: "first.png", mimeType: "image/png", buffer: png }]);
  await browserExpect(tray.getByRole("listitem", { name: "first.png, attached" })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let sentBody = "";
  await page.route("**/api/v1/messages", async (route) => {
    sentBody = route.request().postData() ?? "";
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => sentBody).toContain("images");
  await page.getByRole("textbox", { name: "Message Tomo" }).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "later.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  await browserExpect(tray.getByRole("listitem", { name: "later.png, attached" })).toBeVisible();
  release();
  await browserExpect(page.locator(".message.assistant .markdown").last()).toHaveText("Seen.");
  await browserExpect(tray.getByRole("listitem")).toHaveCount(1);
  await browserExpect(tray.getByRole("listitem", { name: "later.png, attached" })).toBeVisible();
  expect(JSON.parse(sentBody).images).toHaveLength(1);
});

it("Resend on an interrupted message brings its images back into the tray", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let finish!: (value: string) => void;
  mockSdk.responseFn = () => new Promise<string>((resolve) => { finish = resolve; });
  let requestId = "";
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/v1/messages")) requestId = JSON.parse(request.postData() ?? "{}").requestId; });
  const tray = page.getByRole("list", { name: "Attached images" });
  await page.locator("input[type=file]").setInputFiles([{ name: "pic.png", mimeType: "image/png", buffer: png }]);
  await browserExpect(tray.getByRole("listitem", { name: "pic.png, attached" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("with a picture");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(tray).toHaveCount(0);
  await browserExpect.poll(() => channel.request(requestId).state).toBe("running");
  // As a restart would leave it: interrupted, with its filed image in the receipt.
  expect(channel.request(requestId).images).toHaveLength(1);
  (channel as unknown as { state(id: string, state: string): void }).state(requestId, "interrupted");
  await page.getByRole("button", { name: "Resend…" }).click();
  await browserExpect(tray.getByRole("listitem")).toHaveCount(1);
  await browserExpect(tray.getByRole("listitem").first()).toHaveAccessibleName(/attached$/);
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toHaveValue("with a picture");
  finish("done");
});

it("an image-only interrupted message, resent, is dismissed: its interrupted bubble goes", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const finishes: Array<(value: string) => void> = [];
  mockSdk.responseFn = () => new Promise<string>((resolve) => { finishes.push(resolve); });
  const ids: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/v1/messages")) ids.push(JSON.parse(request.postData() ?? "{}").requestId); });
  const tray = page.getByRole("list", { name: "Attached images" });
  await page.locator("input[type=file]").setInputFiles([{ name: "only.png", mimeType: "image/png", buffer: png }]);
  await browserExpect(tray.getByRole("listitem", { name: "only.png, attached" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => ids.length && channel.request(ids[0]).state).toBe("running");
  (channel as unknown as { state(id: string, state: string): void }).state(ids[0], "interrupted");
  await browserExpect(page.getByText("Not answered.", { exact: false })).toHaveCount(1);
  await page.getByRole("button", { name: "Resend…" }).click();
  await browserExpect(tray.getByRole("listitem").first()).toHaveAccessibleName(/attached$/);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => ids.length).toBe(2);
  await browserExpect(page.getByText("Not answered.", { exact: false })).toHaveCount(0);
  for (const finish of finishes) finish("done");
});

it("a thinking block in history reads as a folded, quiet Thinking row; the reply stays the reply", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  const t = Date.now() - 60_000;
  store.append("dm:owner", { role: "user", channel: "web", content: "Which option is cheaper?", timestamp: t });
  // As renderResponseBlocks records a turn with showThinking on: blocks joined by "\n".
  store.append("dm:owner", { role: "assistant", channel: "web", content: "💭 Comparing the two plans by monthly cost.\n\nThe second has a setup fee.\nThe first one is cheaper over a year.", timestamp: t + 5_000 });
  await page.reload();
  const history = page.getByLabel("Conversation history");
  const reply = history.locator("article.message.assistant").last();
  const thinking = reply.getByRole("button", { name: "Thinking" });
  await browserExpect(thinking).toHaveAttribute("aria-expanded", "false");
  await browserExpect(reply).toContainText("The first one is cheaper over a year.");
  await browserExpect(reply).not.toContainText("💭");
  await browserExpect(reply.getByText("Comparing the two plans")).toHaveCount(0);
  // Sans and small, not the reply serif.
  expect(await thinking.evaluate((el) => { const s = getComputedStyle(el); return [s.fontFamily.includes("Source Serif"), s.fontSize]; })).toEqual([false, "12px"]);
  await settledShot("thinking-desktop-closed");
  await thinking.click();
  await browserExpect(reply).toContainText("The second has a setup fee.");
  await settledShot("thinking-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await settledShot("thinking-phone");
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** A screenshot once the collapsible motion has finished and no row is hovered. */
async function settledShot(name: string) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/${name}.png` });
}

it("a subagent's thinking folds, an image output is a chip, and unreadable lines are said", async () => {
  new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).setSdkSessionId("dm:owner", "sdk-think");
  const dir = resolve(mockConfig.sdkSessionsDir, "sdk-think", "subagents");
  mkdirSync(dir, { recursive: true });
  const line = (type: string, content: unknown[]) => JSON.stringify({ type, message: { content } }) + "\n";
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } };
  writeFileSync(resolve(dir, "agent-b1.jsonl"),
    line("user", [{ type: "text", text: "Look at the screenshot." }]) +
    line("assistant", [{ type: "thinking", thinking: "The screenshot path is in the brief; read it first." }, { type: "redacted_thinking", data: "x" },
      { type: "text", text: "Reading the screenshot." }]) +
    line("assistant", [{ type: "tool_use", id: "i1", name: "Read", input: { file_path: "/repo/shot.png" } }]) +
    line("user", [{ type: "tool_result", tool_use_id: "i1", content: [png] }]) +
    line("assistant", [{ type: "hologram", data: 1 }]) +
    line("assistant", [{ type: "text", text: "It shows the login page." }]));
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
    { taskId: "b1", taskType: "local_agent", subagentType: "Explore", description: "Check the screenshot", ambient: false, background: true, startedAt: Date.now() },
  ] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await page.getByRole("button", { name: /Check the screenshot/ }).click();
  const transcript = page.getByLabel("Subagent transcript");
  await browserExpect(transcript).toContainText("It shows the login page.");
  await browserExpect(transcript).toContainText("Some entries could not be read.");
  const thinking = transcript.getByRole("button", { name: "Thinking" });
  await browserExpect(thinking).toHaveCount(1);
  await browserExpect(transcript.getByText("read it first")).toHaveCount(0);
  await thinking.click();
  await browserExpect(transcript).toContainText("The screenshot path is in the brief; read it first.");
  await transcript.getByRole("button", { name: /Read \/repo\/shot\.png/ }).click();
  await browserExpect(transcript).toContainText("Image output, not shown");
  await browserExpect(transcript).not.toContainText("[image]");
  expect(await page.content()).not.toContain("iVBORw0KGgo");
  await settledShot("subagent-thinking-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await settledShot("subagent-thinking-phone");
  await page.setViewportSize({ width: 1440, height: 900 });
});

it("a turn's trace: the todo list open while it runs and folded after, its Sources, and a copyable code block in the reply", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: url });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  store.setSdkSessionId("dm:owner", "sdk-trace");
  const t = Date.now() - 60_000;
  store.append("dm:owner", { role: "user", channel: "web", content: "How do I start an Astro project with pnpm?", timestamp: t });
  const line = (type: string, ms: number, content: unknown[]) => JSON.stringify({ type, isSidechain: false, timestamp: new Date(ms).toISOString(), message: { role: type, content } }) + "\n";
  const todo = (id: string, ms: number, done: number) => line("assistant", ms, [{ type: "tool_use", id, name: "TodoWrite", input: { todos: [
    { content: "Search the docs", activeForm: "Searching the docs" }, { content: "Read the install page", activeForm: "Reading the install page" },
    { content: "Write the answer", activeForm: "Writing the answer" }].map((step, i) => ({ ...step, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) } }])
    + line("user", ms + 50, [{ type: "tool_result", tool_use_id: id, content: "Todos have been modified successfully." }]);
  const running = line("user", t + 100, [{ type: "text", text: "How do I start an Astro project with pnpm?" }]) + todo("p1", t + 1_000, 0) +
    line("assistant", t + 2_000, [{ type: "tool_use", id: "s1", name: "WebSearch", input: { query: "astro pnpm create" } }]) +
    line("user", t + 4_000, [{ type: "tool_result", tool_use_id: "s1", content: 'Web search results for query: "astro pnpm create"\n\nLinks: '
      + JSON.stringify([{ title: "Install Astro", url: "https://docs.astro.build/en/install-and-setup/" }, { title: "pnpm create", url: "https://pnpm.io/cli/create" }])
      + "\n\nUse pnpm create astro." }]) +
    line("assistant", t + 5_000, [{ type: "tool_use", id: "f1", name: "WebFetch", input: { url: "https://docs.astro.build/en/install-and-setup/", prompt: "Steps?" } }]) +
    line("user", t + 7_000, [{ type: "tool_result", tool_use_id: "f1", content: "Run pnpm create astro@latest." }]) +
    todo("p2", t + 8_000, 1) +
    line("assistant", t + 9_000, [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm --version", description: "Check pnpm" } }]);
  mkdirSync(mockConfig.sdkSessionsDir, { recursive: true });
  const file = resolve(mockConfig.sdkSessionsDir, "sdk-trace.jsonl");
  writeFileSync(file, running);
  await page.reload();
  const history = page.getByLabel("Conversation history");
  const todos = history.getByRole("button", { name: /To-dos/ });
  await browserExpect(todos).toContainText("1 of 3 done");
  // The turn is running (typing is live state, not in the reload snapshot).
  const stopTyping = channel.startTyping("owner");
  // Open while the turn runs: the item in progress by its activeForm, shimmering; one list however many TodoWrite calls.
  await browserExpect(todos).toHaveAttribute("aria-expanded", "true");
  await browserExpect(history.getByRole("button", { name: /To-dos/ })).toHaveCount(1);
  await browserExpect(history.locator('[data-todo="active"] [data-status="running"]')).toHaveText(/Reading the install page/);
  await browserExpect(history.getByRole("button", { name: /Check pnpm…/ })).toBeVisible();
  await browserExpect(history.getByRole("button", { name: /^Sources/ })).toContainText("2");
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["dark", 390], ["light", 390]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settledShot(`trace-running-${width === 390 ? "phone" : "desktop"}-${scheme}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // The turn finishes: the list is complete and folds; the reply has a code block.
  writeFileSync(file, running + line("user", t + 10_000, [{ type: "tool_result", tool_use_id: "b1", content: "9.15.0" }]) + todo("p3", t + 11_000, 3));
  store.append("dm:owner", { role: "assistant", channel: "web", timestamp: t + 12_000,
    content: "Run this in an empty folder:\n\n```sh\npnpm create astro@latest\n```\n\nThen follow the prompts." });
  stopTyping();
  watchBus.publish({ type: "transcript", ts: Date.now(), sessionKey: "dm:owner", role: "assistant", channel: "web", text: "x" });
  await browserExpect(history).toContainText("Then follow the prompts.");
  await browserExpect(todos).toContainText("3 of 3 done");
  await browserExpect(todos).toHaveAttribute("aria-expanded", "false");
  const sources = history.getByRole("button", { name: /^Sources/ });
  await sources.click();
  const link = history.getByRole("link", { name: /Install Astro/ });
  await browserExpect(link).toHaveAttribute("href", "https://docs.astro.build/en/install-and-setup/");
  await browserExpect(link).toHaveAttribute("target", "_blank");
  await browserExpect(link).toHaveAttribute("rel", "noopener noreferrer");
  await browserExpect(link).toContainText("docs.astro.build");
  await browserExpect(history.getByRole("link", { name: /pnpm create/ })).toContainText("pnpm.io");
  // Deduplicated: the fetched page is the search's first link.
  await browserExpect(history.locator('[data-kind="sources"] a')).toHaveCount(2);
  // Nothing from those hosts was requested by the page.
  expect(requests.some((request) => /astro\.build|pnpm\.io/.test(new URL(request).hostname))).toBe(false);
  const reply = history.locator("article.message.assistant").last();
  await browserExpect(reply.locator('[data-slot="code-block-title"]')).toHaveText("sh");
  await reply.locator('[data-slot="code-block"]').hover();
  await reply.getByRole("button", { name: "Copy code" }).click();
  await browserExpect(reply.getByRole("button", { name: "Copied" })).toBeVisible();
  await reply.locator('[data-slot="code-block"]').screenshot({ path: "test-results/trace-code-copied.png" });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("pnpm create astro@latest");
  // Tool panes keep their plain <pre>: no copy button there.
  await history.getByRole("button", { name: /Looked up 2 pages/ }).click();
  await history.getByRole("button", { name: /Check pnpm/ }).click();
  await browserExpect(history.locator('[data-kind="group"] [data-slot="code-block"]')).toHaveCount(0);
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["dark", 390], ["light", 390]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await settledShot(`trace-done-${width === 390 ? "phone" : "desktop"}-${scheme}`);
  }
  await todos.click();
  await browserExpect(todos).toHaveAttribute("aria-expanded", "true");
  await settledShot("trace-todos-done-phone-light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
});
