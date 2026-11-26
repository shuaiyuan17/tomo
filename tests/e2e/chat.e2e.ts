import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { OutgoingMediaStore, outgoingImagesDir } from "../../src/web/outgoing-media.js";
import { uploadsDir } from "../../src/web/uploads.js";
import { solidPng } from "../helpers/png.js";

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
    uploads: { dir: uploadsDir(mockConfig.tomoHome), workspaceDir: mockConfig.workspaceDir, fileDir: mockConfig.workspaceDir } }); provider = new MockChannel("telegram");
  supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0, fileUploadsEnabled: true });
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

it("round-trips 16,000 three-byte characters through the chat and transcript", async () => {
  const text = "€".repeat(16_000);
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

  // The rail's open state is remembered too: after a reload it is already open (a click here would close it).
  await page.reload();
  await browserExpect(rail).toHaveAttribute("data-state", "open");
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

it("loads the Study as a lazy chunk under the CSP, cached immutable and compressed", async () => {
  const chunks: Record<string, string | undefined>[] = [];
  page.on("response", (response) => {
    if (/^\/assets\/study-[\w-]+\.js$/.test(new URL(response.url()).pathname)) chunks.push(response.headers());
  });
  await page.evaluate(() => {
    const w = window as unknown as { __csp: string[] }; w.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => w.__csp.push(event.violatedDirective));
  });
  // Not on the chat's critical path: nothing of the Study is fetched until it is opened.
  expect(chunks).toHaveLength(0);
  await page.getByRole("button", { name: "The Study" }).click();
  await browserExpect(page.locator("#study")).toBeVisible();
  expect(chunks).toHaveLength(1);
  expect(chunks[0]["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(chunks[0]["content-encoding"]).toBe("br");
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
});

it("a Study chunk that fails to load shows Reload in its place; the rest of the app stays", async () => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/assets\/study-[\w-]+\.js$/, (route) => route.abort());
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  await input.fill("a draft that must survive");
  await page.getByRole("button", { name: "The Study" }).first().click();
  await browserExpect(page.getByText("The Study didn't load. Reload the page to try again.")).toBeVisible();
  await browserExpect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  // Header, sidebar and the (hidden) chat are still mounted, the stream still live.
  await browserExpect(page.locator("header")).toBeVisible();
  await browserExpect(page.locator("#sidebar")).toHaveCount(1);
  await browserExpect(page.locator("#conversation")).toHaveCount(1);
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Conversation" }).first().click();
  await browserExpect(page.locator("#conversation")).toBeVisible();
  await browserExpect(input).toHaveValue("a draft that must survive");
  expect(errors).toEqual([]);
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
    { taskId: "f1", taskType: "local_agent", description: "Check the tests", ambient: false, background: false, startedAt: Date.now() },
  ] });
  const toggle = page.getByRole("button", { name: /^Tasks, 2 running$/ });
  await browserExpect(toggle).toHaveAttribute("aria-pressed", "false");
  // Desktop: pinned rail, not modal, persisted across reloads.
  await toggle.click();
  await browserExpect(page.getByRole("complementary", { name: "Tasks" })).toContainText("Reading src/web");
  // Only the task that outlives the reply is tagged; the one the turn is waiting on is not.
  await browserExpect(page.getByTestId("task-background")).toHaveCount(1);
  await browserExpect(page.getByRole("button", { name: /Map the repo/ })).toContainText(/background · \d/);
  await browserExpect(page.getByRole("button", { name: /Check the tests/ })).not.toContainText("background");
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
  // Its card lines up with the Brief card above, left and right.
  await browserExpect.poll(() => offset(transcript.getByText("Message from Tomo").locator(".."), page.getByRole("region", { name: "Brief" }))).toEqual([0, 0]);
  await browserExpect(transcript.getByRole("button", { name: /Read \/repo\/CHANGELOG\.md/ })).toHaveCount(0);
  await transcript.getByRole("button", { name: /Read a file, ran a search/ }).click();
  await transcript.getByRole("button", { name: /Read \/repo\/CHANGELOG\.md/ }).click();
  await browserExpect(transcript).toContainText("## 0.12.0 entries");
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await browserExpect(page.getByRole("button", { name: /Review the release/ })).toBeVisible();
});

/** A box's left and right edges, in whole pixels. */
const edges = (box: ReturnType<Page["locator"]>) => box.evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
/** How far `box`'s left and right edges sit from `ref`'s, once the rail has finished sliding in. */
const offset = async (box: ReturnType<Page["locator"]>, ref: ReturnType<Page["locator"]>) => {
  const [a, b] = [await edges(box), await edges(ref)];
  return [a[0] - b[0], a[1] - b[1]];
};

it("an opened owner task can be moved to the background and stopped; a group's task offers neither", async () => {
  const calls: string[] = [];
  let answer = true;
  (channel as unknown as { taskControl: unknown }).taskControl = {
    stop: async (key: string, taskId: string) => { calls.push(`stop ${key} ${taskId}`); return answer; },
    background: async (key: string, toolUseId: string) => { calls.push(`background ${key} ${toolUseId}`); return answer; } };
  const task = (background: boolean) => ({ taskId: "f1", taskType: "local_agent", description: "Check the tests", ambient: false, background, toolUseId: "toolu_f1", startedAt: Date.now() });
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task(false)] });
  watchBus.publish({ type: "tasks", sessionKey: "telegram:-1", tasks: [{ ...task(false), taskId: "g1", description: "Group work" }] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await page.getByRole("button", { name: /Check the tests/ }).click();
  const move = page.getByRole("button", { name: "Move to background" });
  const stop = page.getByRole("button", { name: "Stop task" });
  // Refused by the SDK (it had just finished): said quietly, nothing else changes.
  answer = false;
  await move.click();
  await browserExpect(page.getByRole("status").filter({ hasText: "Couldn't move it" })).toBeVisible();
  answer = true;
  await move.click();
  await browserExpect.poll(() => calls).toEqual(["background dm:owner toolu_f1", "background dm:owner toolu_f1"]);
  // The daemon reports it in the background: the offer goes, the tag shows, Stop stays.
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [task(true)] });
  await browserExpect(move).toHaveCount(0);
  await browserExpect(page.getByRole("complementary", { name: "Tasks" })).toContainText("Working · background");
  await page.screenshot({ path: "test-results/task-controls.png" });
  await stop.click();
  await browserExpect.poll(() => calls.at(-1)).toBe("stop dm:owner f1");
  // Ended: nothing left to act on.
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [{ ...task(true), status: "stopped" }] });
  await browserExpect(stop).toHaveCount(0);
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await page.getByRole("button", { name: /Group work/ }).click();
  await browserExpect(page.getByRole("heading", { name: "Group work" })).toBeVisible();
  await browserExpect(stop).toHaveCount(0);
  await browserExpect(move).toHaveCount(0);
});

it("a shell task: its Output card lines up with the Command card above it", async () => {
  await page.route("**/tasks/b1/command", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ text: "/tmp/merge-seq.sh 2>&1", truncated: false }) }));
  await page.route("**/tasks/b1/output", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ output: "351 already merged\n352 already merged\n", size: 38 }) }));
  watchBus.publish({ type: "tasks", sessionKey: "dm:owner", tasks: [
    { taskId: "b1", taskType: "local_bash", description: "Bring the watcher back up after restart", ambient: false, background: true, startedAt: Date.now() },
  ] });
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await page.getByRole("button", { name: /Bring the watcher back up/ }).click();
  const command = page.getByRole("region", { name: "Command" });
  await browserExpect(command).toContainText("/tmp/merge-seq.sh");
  const output = page.getByText("352 already merged").locator("xpath=ancestor::div[contains(@class,'border')][1]");
  await browserExpect(output).toBeVisible();
  await browserExpect.poll(() => offset(output, command)).toEqual([0, 0]);
  await page.screenshot({ path: "test-results/shell-task.png" });
});

it("a message Tomo sent on its own carries a label, and no [proactive] marker in its text", async () => {
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  store.append("dm:owner", { role: "assistant", channel: "imessage", content: "[proactive] Restarted, you can carry on.", timestamp: Date.now() - 1_000 });
  await page.reload();
  const sent = page.locator("article.message.assistant").filter({ hasText: "Restarted" });
  await browserExpect(sent).toBeVisible();
  await browserExpect(sent.locator(".markdown")).toHaveText("Restarted, you can carry on.");
  await browserExpect(sent).toContainText("Sent proactively");
  await browserExpect(page.locator("main")).not.toContainText("[proactive]");
});

it("an Enter that confirms an IME candidate (Safari order) does not send", async () => {
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  await input.fill("ni hao");
  // Safari fires compositionend before the confirming Enter's keydown, which then has isComposing=false.
  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hello" }));
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
  store.append("dm:owner", { role: "assistant", channel: "telegram", timestamp: t, content: "Picked up the stale #383 and split it into 3 PRs, the first is merged" });
  store.append("dm:owner", { role: "user", channel: "telegram", timestamp: t + 1, content: `[Sent an image, saved to: ${file}] like this\n• one\n• two` });
  store.append("dm:owner", { role: "user", channel: "imessage", timestamp: t + 2, content: '[replying to: "Picked up the stale #383 and split it into 3 PRs,…"] nice!!' });
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
  await browserExpect(quote).toContainText("Picked up the stale #383");
  await browserExpect(page.getByText("nice!!", { exact: true })).toBeVisible();
  await browserExpect(page.locator("main")).not.toContainText("[replying to");
  await quote.click();
  await browserExpect(page.locator("article.message.assistant").filter({ hasText: "the first is merged" })).toHaveClass(/bg-primary/);
  await image.click();
  await browserExpect(page.getByRole("dialog", { name: "Image" })).toBeVisible();
  // The overlay covers the window: no row or scroller contains it (paint/layout containment would).
  expect(await page.getByRole("dialog", { name: "Image" }).evaluate((el) => { const r = el.getBoundingClientRect(); return [r.width === innerWidth, r.height === innerHeight]; })).toEqual([true, true]);
  // No ancestor carries a transform either (the shell only does while the iOS keyboard is up, keyboard-viewport.ts).
  expect(await page.getByRole("dialog", { name: "Image" }).evaluate((el) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).transform !== "none") return a.tagName;
    return null;
  })).toBeNull();
  // Nor is it clipped by an ancestor's mask or clip-path (a mask on the scroller once hid its backdrop and Close button).
  expect(await page.getByRole("dialog", { name: "Image" }).evaluate((el) => {
    const clipped: string[] = [];
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a) as CSSStyleDeclaration & { webkitMaskImage?: string };
      if ((cs.maskImage && cs.maskImage !== "none") || (cs.webkitMaskImage && cs.webkitMaskImage !== "none") || cs.clipPath !== "none") clipped.push(a.tagName);
    }
    return clipped;
  })).toEqual([]);
  await browserExpect(page.getByRole("button", { name: "Close image" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await browserExpect(page.getByRole("dialog", { name: "Image" })).toHaveCount(0);
});

it("shows the Plan usage card with a named state and a refresh button", async () => {
  const card = page.getByRole("region", { name: /Plan usage/ });
  await browserExpect(card).toContainText("Usage isn't available here.");
  await card.getByRole("button", { name: "Refresh plan usage" }).click();
  await browserExpect(card.getByRole("button", { name: "Refresh plan usage" })).toHaveAttribute("title", /Not updated yet/);
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

it("a non-image file the agent sends (MEDIA:<path>.md) is a card with name and size: Download hands over its bytes, Preview shows its text; kept on reload", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "tomo-e2e-file-"));
  const file = resolve(dir, "pr636-review.md");
  const text = "# Review\n\n- P2: timestamps <b>unchecked</b>\n";
  writeFileSync(file, text);
  mockSdk.responseFn = () => `The review:\nMEDIA:${file}`;
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("send me the review");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page.locator("article.message.assistant").filter({ hasText: "The review:" });
  const card = reply.getByRole("group", { name: `File pr636-review.md, ${Buffer.byteLength(text)} B` });
  await browserExpect(card).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download pr636-review.md" }).click()]);
  expect(download.suggestedFilename()).toBe("pr636-review.md");
  expect(readFileSync((await download.path())!, "utf8")).toBe(text);
  await card.getByRole("button", { name: "Preview pr636-review.md" }).click();
  const preview = page.getByRole("dialog", { name: "Preview pr636-review.md" });
  // Plain text, never markup.
  await browserExpect(preview.locator("pre")).toHaveText(text.trimEnd());
  await browserExpect(preview.locator("b")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await browserExpect(preview).toHaveCount(0);
  // Recorded and reloaded: the same card, from the store (the source can go); never the path.
  rmSync(dir, { recursive: true, force: true });
  await page.reload();
  await browserExpect(page.locator("article.message.assistant").filter({ hasText: "The review:" }).getByRole("group", { name: /^File pr636-review\.md/ })).toBeVisible();
  await browserExpect(page.locator("main")).not.toContainText("MEDIA:");
  expect(await page.content()).not.toContain(dir);
});

it("a picture the owner's conversation sent on another channel (a Telegram reply) shows on the web too, not as \"no longer available\"", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(resolve(tmpdir(), "tomo-e2e-mirror-"));
  const file = resolve(dir, "after.png");
  writeFileSync(file, solidPng(4, 4));
  mockSdk.responseFn = () => `Before and after:\nMEDIA:${file}`;
  await provider.simulateMessage(makeMsg({ chatId: "test-owner", senderName: "Owner", text: "Show me the UI change" }));
  await drainQueue(agent);
  expect(provider.delivered.some((message) => message.photo === file)).toBe(true);
  await page.reload();
  const image = page.locator("article.message.assistant").filter({ hasText: "Before and after:" }).getByRole("img", { name: "Image" });
  await browserExpect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth).catch(() => 0)).toBe(4);
  await browserExpect(page.getByText("Image (no longer available)")).toHaveCount(0);
  expect(await page.content()).not.toContain(dir);
});

it("the tray survives a reload: finished uploads come back (thumbnail and all) and ride the next message to the model", async () => {
  mockSdk.responseFn = () => "Got both screenshots.";
  await page.locator("input[type=file]").setInputFiles([
    { name: "normal.png", mimeType: "image/png", buffer: solidPng(3, 3) },
    { name: "typing.png", mimeType: "image/png", buffer: solidPng(3, 3) }]);
  const tray = page.getByRole("list", { name: "Attachments" });
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  // iPad Safari reloads a backgrounded tab: the tray used to come back empty while the uploads sat staged.
  await page.reload();
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await browserExpect(tray.getByRole("listitem", { name: "normal.png, attached" })).toBeVisible();
  await browserExpect(tray.getByRole("listitem", { name: "typing.png, attached" })).toBeVisible();
  await browserExpect.poll(() => tray.locator("img").first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth).catch(() => 0)).toBe(3);
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("截图有收到吗？");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator(".message.assistant .markdown").last()).toHaveText("Got both screenshots.");
  const blocks = mockSdk.userContents.at(-1) as Array<{ type: string }>;
  expect(blocks.filter((block) => block.type === "image")).toHaveLength(2);
  expect(readdirSync(uploadsDir(mockConfig.tomoHome))).toEqual([]);
  // Sent: nothing comes back on the next reload.
  await page.reload();
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await browserExpect(tray).toHaveCount(0);
});

it("after a reload, Send waits for the tray to come back; a read that errs (or a send still filing it) shows as failed with Retry, never silently dropped", async () => {
  await page.locator("input[type=file]").setInputFiles([{ name: "slow.png", mimeType: "image/png", buffer: solidPng(2, 2) }]);
  const tray = page.getByRole("list", { name: "Attachments" });
  await browserExpect(tray.getByRole("listitem", { name: "slow.png, attached" })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let mode: "fail" | "hold" = "fail";
  await page.route(/\/api\/v1\/uploads\/[a-f0-9]{32}$/, async (route) => {
    if (mode === "fail") { await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "upload_claimed" }) }); return; }
    await held; await route.continue();
  });
  const send = page.getByRole("button", { name: "Send", exact: true });
  // The read errs: the item stays, failed, and Send stays off with text typed.
  await page.reload();
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await browserExpect(tray.getByRole("listitem", { name: "slow.png, upload failed" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("with the picture");
  await browserExpect(send).toBeDisabled();
  // Kept across another reload too; this time the read is slow: shown as uploading, Send still off.
  mode = "hold";
  await page.reload();
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await browserExpect(tray.getByRole("listitem", { name: /^slow\.png, uploading/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("with the picture");
  await browserExpect(send).toBeDisabled();
  release();
  await browserExpect(tray.getByRole("listitem", { name: "slow.png, attached" })).toBeVisible();
  await browserExpect(send).toBeEnabled();
});

it("a kept upload the server no longer has (sent elsewhere, expired) is dropped on reload, not offered", async () => {
  await page.locator("input[type=file]").setInputFiles([{ name: "gone.png", mimeType: "image/png", buffer: solidPng(2, 2) }]);
  const tray = page.getByRole("list", { name: "Attachments" });
  await browserExpect(tray.getByRole("listitem", { name: "gone.png, attached" })).toBeVisible();
  // Gone for good (as when it expires or another send took it): the server records it, and the page drops it.
  const { discardUpload } = await import("../../src/web/uploads.js");
  for (const name of readdirSync(uploadsDir(mockConfig.tomoHome))) discardUpload(uploadsDir(mockConfig.tomoHome), name.split(".")[0]);
  await page.reload();
  await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await browserExpect(tray).toHaveCount(0);
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
  writeFileSync(resolve(mockConfig.workspaceDir, "IDENTITY.md"), "- **Name:** Pixel\n");
  const { utimesSync } = await import("node:fs");
  utimesSync(resolve(mockConfig.workspaceDir, "IDENTITY.md"), new Date(), new Date(Date.now() + 5_000));
  await page.reload();
  await browserExpect(page.getByRole("textbox", { name: "Message Pixel" })).toBeVisible();
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
  // Its title is the model's words, in the text face; a command (no description), a path, stay monospace.
  const titleFont = (name: string | RegExp) => history.getByRole("button", { name }).locator("[data-slot=trace-title]").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await titleFont("Check the working tree")).not.toMatch(/mono/i);
  expect(await titleFont(/gh pr list/)).toMatch(/mono/i);
  expect(await titleFont(/Read \/repo\/CHANGELOG\.md/)).toMatch(/mono/i);
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
    // A bubble is replaced when its pending copy becomes the recorded one; a detached one reads as "not fitted yet".
    const scroller = el.closest("[aria-label='Conversation history']");
    if (!scroller) return { below: -1, topIn: false };
    const view = scroller.getBoundingClientRect(), box = el.getBoundingClientRect();
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
  await browserExpect.poll(async () => { const { below } = await fit(sent); return below >= 0 && below < 60; }).toBe(true);
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

for (const [label, olderDay] of [["the same day", 0], ["an earlier day", 86_400_000]] as const) {
  it(`Load earlier does not move the first shown message when the earlier page ends on ${label} (day dividers never sit at a row's top)`, async () => {
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    const t = Date.now() - 600_000;
    // The first page shows messages 30..129; "Load earlier" brings 0..29.
    for (let i = 0; i < 130; i++) store.append("dm:owner", { role: i % 2 ? "assistant" : "user", channel: "web", content: `Message ${i}\n\nwith a second paragraph`, timestamp: t + i * 1_000 - (i < 30 ? olderDay : 0) });
    await page.reload();
    const history = page.getByLabel("Conversation history");
    const earlier = page.getByRole("button", { name: "Load earlier messages" });
    await browserExpect(earlier).toBeVisible();
    await history.hover();
    await browserExpect.poll(async () => { await page.mouse.wheel(0, -20_000); return history.evaluate((el) => el.scrollTop); }).toBe(0);
    const article = history.locator("article.message").filter({ hasText: /^.*Message 30\b/ }).first();
    const top = () => article.evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const before = await top();
    await earlier.click();
    await browserExpect(history).toContainText("Message 0");
    await page.waitForTimeout(300);
    expect(Math.abs(await top() - before)).toBeLessThanOrEqual(1);
  });
}

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
  const tray = page.getByRole("list", { name: "Attachments" });
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
  // A fake image (an SVG named .png) is never shown as one: the server decides by its bytes, so it becomes a plain file chip.
  await page.locator("input[type=file]").setInputFiles([{ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") }]);
  const evil = tray.getByRole("listitem", { name: "evil.png, attached" });
  await browserExpect(evil).toHaveAttribute("data-kind", "file");
  await browserExpect(evil.locator("img")).toHaveCount(0);
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

it("attaches any file with \"+\": a .md shows as a chip, is sent, and the bubble shows a file card — filed like iMessage's, card kept on reload", async () => {
  mockSdk.responseFn = () => "Read your notes.";
  const md = Buffer.from("# Notes\n\nhello\n");
  const plus = page.getByRole("button", { name: "Attach files" });
  await browserExpect(plus).toBeEnabled();
  // The picker takes any file (no accept filter).
  expect(await page.locator("input[type=file]").getAttribute("accept")).toBeNull();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), plus.click()]);
  await chooser.setFiles([{ name: "notes.md", mimeType: "text/markdown", buffer: md }]);
  const tray = page.getByRole("list", { name: "Attachments" });
  const chip = tray.getByRole("listitem", { name: "notes.md, attached" });
  await browserExpect(chip).toHaveAttribute("data-kind", "file");
  await browserExpect(chip).toContainText("notes.md");
  await browserExpect(chip).toContainText(`${md.length} B`);
  await browserExpect(chip.getByRole("button", { name: "Remove notes.md" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("see attached");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.locator(".message.assistant .markdown").last()).toHaveText("Read your notes.");
  await browserExpect(tray).toHaveCount(0);
  const card = page.locator(".message.user").last().getByRole("group", { name: `File notes.md, ${md.length} B` });
  await browserExpect(card).toBeVisible();
  // What the agent got: the shared inbound-file marker, the path under incoming-files, no bytes.
  const sent = JSON.stringify(mockSdk.userContents.at(-1));
  const { readdirSync, readFileSync: read } = await import("node:fs");
  const filed = readdirSync(resolve(mockConfig.workspaceDir, "memory", "incoming-files"), { recursive: true }).map(String).filter((name) => name.endsWith("_web_owner_notes.md"));
  expect(filed).toHaveLength(1);
  expect(filed[0]).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{6}_web_owner_notes\.md$/);
  const path = resolve(mockConfig.workspaceDir, "memory", "incoming-files", filed[0]);
  expect(read(path).equals(md)).toBe(true);
  expect(sent).toContain(`[Sent a file: notes.md (text/markdown, ${md.length} B) saved to ${path}. Contents not attached to this message — open the path if you need them.] see attached`);
  expect(readdirSync(uploadsDir(mockConfig.tomoHome))).toEqual([]);
  // Recorded: after a reload the card comes back from the transcript; the path is never shown.
  await page.reload();
  await browserExpect(page.locator(".message.user").last().getByRole("group", { name: `File notes.md, ${md.length} B` })).toBeVisible();
  await browserExpect(page.locator("main")).not.toContainText("incoming-files");
});

it("an image pasted while a message is sending stays in the tray for the next one", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  mockSdk.responseFn = () => "Seen.";
  const tray = page.getByRole("list", { name: "Attachments" });
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
  const tray = page.getByRole("list", { name: "Attachments" });
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
  const tray = page.getByRole("list", { name: "Attachments" });
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

it("Resend of an image + file message: Send stays off until its image is back, then both go and the original is dismissed", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const finishes: Array<(value: string) => void> = [];
  mockSdk.responseFn = () => new Promise<string>((resolve) => { finishes.push(resolve); });
  const bodies: Array<{ requestId: string; images?: string[]; refiled?: string[] }> = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/v1/messages")) bodies.push(JSON.parse(request.postData() ?? "{}")); });
  const tray = page.getByRole("list", { name: "Attachments" });
  await page.locator("input[type=file]").setInputFiles([{ name: "pic.png", mimeType: "image/png", buffer: png }, { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# n\n") }]);
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("both of these");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length && channel.request(bodies[0].requestId).state).toBe("running");
  (channel as unknown as { state(id: string, state: string): void }).state(bodies[0].requestId, "interrupted");
  // Reading the image back is held: the file is in the tray already, but Send stays off.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/sessions/*/media**", async (route) => { await held; await route.continue(); });
  await page.getByRole("button", { name: "Resend…" }).click();
  await browserExpect(tray.getByRole("listitem", { name: "notes.md, attached" })).toBeVisible();
  await browserExpect(page.getByText("Restoring attachments…")).toBeVisible();
  const send = page.getByRole("button", { name: "Send", exact: true });
  await browserExpect(send).toBeDisabled();
  await page.getByRole("textbox", { name: "Message Tomo" }).press("Enter");
  expect(bodies).toHaveLength(1);
  release();
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  await browserExpect(send).toBeEnabled();
  await send.click();
  await browserExpect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].images).toHaveLength(1);
  expect(bodies[1].refiled).toEqual([channel.request(bodies[0].requestId).files?.[0]?.path ?? expect.any(String)]);
  await browserExpect.poll(() => channel.request(bodies[0].requestId).files).toBeUndefined();
  for (const finish of finishes) finish("done");
});

it("Resend where an image cannot be read back: says so, and sending keeps the original queued", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const finishes: Array<(value: string) => void> = [];
  mockSdk.responseFn = () => new Promise<string>((resolve) => { finishes.push(resolve); });
  const bodies: Array<{ requestId: string }> = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/v1/messages")) bodies.push(JSON.parse(request.postData() ?? "{}")); });
  const tray = page.getByRole("list", { name: "Attachments" });
  await page.locator("input[type=file]").setInputFiles([{ name: "pic.png", mimeType: "image/png", buffer: png }, { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# n\n") }]);
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("both again");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length && channel.request(bodies[0].requestId).state).toBe("running");
  (channel as unknown as { state(id: string, state: string): void }).state(bodies[0].requestId, "interrupted");
  await page.route("**/api/v1/sessions/*/media**", (route) => route.fulfill({ status: 404, body: "{}" }));
  await page.getByRole("button", { name: "Resend…" }).click();
  await browserExpect(page.getByText("1 attachment could not be restored", { exact: false })).toBeVisible();
  await browserExpect(tray.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length).toBe(2);
  await browserExpect.poll(() => channel.request(bodies[1].requestId).state).not.toBe("unknown");
  // Not dismissed: the original is still awaiting the owner.
  expect(channel.request(bodies[0].requestId)).toMatchObject({ state: "interrupted", text: "both again" });
  for (const finish of finishes) finish("done");
});

it("Resend A, then Resend B before A's image is back: A's late result never lands on B, and A's items leave the tray", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const finishes: Array<(value: string) => void> = [];
  mockSdk.responseFn = () => new Promise<string>((resolve) => { finishes.push(resolve); });
  const bodies: Array<{ requestId: string; images?: string[]; refiled?: string[] }> = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/v1/messages")) bodies.push(JSON.parse(request.postData() ?? "{}")); });
  const tray = page.getByRole("list", { name: "Attachments" });
  const box = page.getByRole("textbox", { name: "Message Tomo" });
  const interrupt = (id: string) => (channel as unknown as { state(id: string, state: string): void }).state(id, "interrupted");
  // A: an image and a file.
  await page.locator("input[type=file]").setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: png }, { name: "a.md", mimeType: "text/markdown", buffer: Buffer.from("a") }]);
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  await box.fill("message A");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length && channel.request(bodies[0].requestId).state).toBe("running");
  interrupt(bodies[0].requestId);
  const pathA = channel.request(bodies[0].requestId).images![0];
  // B: one image.
  await page.locator("input[type=file]").setInputFiles([{ name: "b.png", mimeType: "image/png", buffer: png }]);
  await browserExpect(tray.getByRole("listitem", { name: "b.png, attached" })).toBeVisible();
  await box.fill("message B");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length === 2 && channel.request(bodies[1].requestId).images?.length).toBe(1);
  interrupt(bodies[1].requestId);
  const pathB = channel.request(bodies[1].requestId).images![0];
  // Every image read is held, then released one by one.
  const held = new Map<string, () => void>();
  await page.route("**/api/v1/sessions/*/media**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path")!;
    await new Promise<void>((resolve) => held.set(path, resolve));
    await route.continue();
  });
  const resendOf = (text: string) => page.locator("article.message.user").filter({ hasText: text }).getByRole("button", { name: "Resend…" });
  await resendOf("message A").click();
  await browserExpect(tray.getByRole("listitem", { name: "a.md, attached" })).toBeVisible();
  await browserExpect.poll(() => held.has(pathA)).toBe(true);
  await resendOf("message B").click();
  await browserExpect(box).toHaveValue("message B");
  // A's file left with A's draft.
  await browserExpect(tray.getByRole("listitem")).toHaveCount(0);
  await browserExpect.poll(() => held.has(pathB)).toBe(true);
  // A's image comes back late: B stays locked and gets nothing.
  held.get(pathA)!();
  await page.waitForTimeout(500);
  await browserExpect(page.getByText("Restoring attachments…")).toBeVisible();
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await browserExpect(tray.getByRole("listitem")).toHaveCount(0);
  held.get(pathB)!();
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].images).toHaveLength(1);
  expect(bodies[2].refiled).toBeUndefined();
  // B was resent and dismissed; A still awaits the owner.
  await browserExpect.poll(() => channel.request(bodies[1].requestId).text).toBeUndefined();
  expect(channel.request(bodies[0].requestId)).toMatchObject({ state: "interrupted", text: "message A" });
  for (const finish of finishes) finish("done");
});

it("switching Resend from A to B (both with an image and a file, each fully restored) sends only B's attachments", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const finishes: Array<(value: string) => void> = [];
  mockSdk.responseFn = () => new Promise<string>((resolve) => { finishes.push(resolve); });
  const bodies: Array<{ requestId: string; images?: string[]; refiled?: string[] }> = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/api/v1/messages")) bodies.push(JSON.parse(request.postData() ?? "{}")); });
  const tray = page.getByRole("list", { name: "Attachments" });
  const box = page.getByRole("textbox", { name: "Message Tomo" });
  const interrupt = (id: string) => (channel as unknown as { state(id: string, state: string): void }).state(id, "interrupted");
  for (const name of ["a", "b"]) {
    await page.locator("input[type=file]").setInputFiles([{ name: `${name}.png`, mimeType: "image/png", buffer: png }, { name: `${name}.md`, mimeType: "text/markdown", buffer: Buffer.from(name) }]);
    await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
    await box.fill(`message ${name.toUpperCase()}`);
    const sent = bodies.length;
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect.poll(() => bodies.length > sent && channel.request(bodies[sent].requestId).files?.length).toBe(1);
    interrupt(bodies[sent].requestId);
  }
  const [a, b] = [channel.request(bodies[0].requestId), channel.request(bodies[1].requestId)];
  const resendOf = (text: string) => page.locator("article.message.user").filter({ hasText: text }).getByRole("button", { name: "Resend…" });
  await resendOf("message A").click();
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  await resendOf("message B").click();
  await browserExpect(box).toHaveValue("message B");
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  // Exactly B's two: its file and its image (named from where it was filed).
  await browserExpect(tray.getByRole("listitem", { name: /attached$/ })).toHaveCount(2);
  await browserExpect(tray.getByRole("listitem", { name: "b.md, attached" })).toBeVisible();
  await browserExpect(tray.getByRole("listitem", { name: `${b.images![0].split("/").at(-1)}, attached` })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect.poll(() => bodies.length).toBe(3);
  expect(bodies[2].refiled).toEqual([b.files![0].path]);
  expect(bodies[2].images).toHaveLength(1);
  // What the daemon filed for the resend: B's file, none of A's.
  await browserExpect.poll(() => channel.request(bodies[2].requestId).files?.map((f) => f.path)).toEqual([b.files![0].path]);
  expect(channel.request(bodies[2].requestId).files!.some((f) => f.path === a.files![0].path)).toBe(false);
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

it("own bubbles fit their content (85% cap) and show ✓ sent, then ✓✓ read by the agent", async () => {
  mockSdk.stampUserUuids = true;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  mockSdk.responseFn = async () => { await gate; return "A tick is a receipt."; };
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("What's the tick?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const own = page.locator("article.message.user").filter({ hasText: "What's the tick?" }).last();
  const receipt = own.locator(".read-receipt");
  await browserExpect(receipt).toHaveAttribute("data-receipt", "sent");
  release();
  await browserExpect(receipt).toHaveAttribute("data-receipt", "read");
  await browserExpect(receipt).toHaveAttribute("title", "Read by Tomo");
  // Measured once the turn is over and the bubble is the settled history row.
  await browserExpect(page.locator("article.message.assistant").filter({ hasText: "A tick is a receipt." })).toBeVisible();
  // Hidden until the bubble is hovered.
  const opacity = () => receipt.evaluate((el) => Number(getComputedStyle(el).opacity));
  await page.mouse.move(0, 0);
  await browserExpect.poll(opacity).toBe(0);
  await own.locator(".own-bubble").hover();
  await browserExpect.poll(opacity).toBeGreaterThan(0.5);
  await receipt.click();
  await browserExpect(receipt).toContainText("Read by Tomo");
  // A row can be re-rendered (pending → history) between reads: measure in one evaluate, retried.
  const measure = (row: typeof own) => row.evaluate((el) => {
    const r = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
    const b = r(".own-bubble"); const t = r(".read-receipt");
    return { column: el.getBoundingClientRect().width, bubble: b.width,
      // The tick sits inside the bubble, in its bottom-right corner.
      inCorner: t.right <= b.right && t.right > b.right - 24 && t.bottom <= b.bottom && t.bottom > b.bottom - 16 };
  });
  await browserExpect.poll(async () => { const m = await measure(own); return m.bubble < m.column * 0.4 && m.inCorner; }).toBe(true);

  mockSdk.responseFn = () => "ok";
  const long = "long words ".repeat(120).trim();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill(long);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const longOwn = page.locator("article.message.user").filter({ hasText: "long words long words" }).last();
  await browserExpect(longOwn.locator(".read-receipt")).toHaveAttribute("data-receipt", "read");
  await browserExpect.poll(async () => { const m = await measure(longOwn); return m.bubble <= m.column * 0.85 + 1 && m.bubble > m.column * 0.8; }).toBe(true);
});

it("the top bar is 45px on every screen and holds only the wordmark and where you are", async () => {
  const token = readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim();
  /** The bar's height, and its text (spaces dropped) with the toggles' and the connection's taken out. */
  const bar = async (p: Page) => {
    const header = p.locator("header");
    const box = (await header.boundingBox())!;
    const text = await header.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("button, [role=status], .sr-only").forEach((n) => n.remove());
      return (copy.textContent ?? "").replace(/\s+/g, "");
    });
    return { box, text };
  };
  // Desktop (the suite's 1440 x 900 page): the Conversation, Home and the Study.
  let { box, text } = await bar(page);
  expect(box.height).toBe(45);
  expect(text).toBe("tomo.Conversation");
  await page.evaluate(() => { window.location.hash = "home"; });
  await browserExpect(page.getByTestId("header-title")).toHaveText("Home");
  expect((await bar(page)).text).toBe("tomo.Home");
  await page.evaluate(() => { window.location.hash = "study/todos"; });
  await browserExpect(page.getByRole("tab", { name: "Todos" })).toBeVisible();
  ({ box, text } = await bar(page));
  expect(box.height).toBe(45);
  expect(text).toBe("tomo.TheStudy");
  // No title block or description over the Study's tabs: the tabs come first under the bar.
  const tabs = (await page.getByRole("tablist", { name: "Study sections" }).boundingBox())!;
  expect(tabs.y - (box.y + box.height)).toBeLessThan(24);
  await page.evaluate(() => { window.location.hash = ""; });

  // A phone, and a foldable held open (wide, touch, not tall): the same 45px bar.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1000, height: 700 }]) {
    const other = await browser.newPage({ viewport, hasTouch: true, isMobile: true });
    await other.goto(`${url}/?t=${token}`);
    await browserExpect(other.getByRole("textbox", { name: "Message Tomo" })).toBeEnabled();
    const header = await bar(other);
    expect(header.box.height).toBe(45);
    expect(header.text).toBe("tomo.Conversation");
    await browserExpect(other.locator("header").getByRole("status")).toContainText("Connected");
    // The Tasks overlay and its backdrop start right under the bar.
    await other.getByRole("button", { name: /^Tasks/ }).click();
    await browserExpect(other.locator("#tasks-rail")).toBeVisible();
    await other.waitForTimeout(300);
    expect(Math.abs((await other.locator("#tasks-rail").boundingBox())!.y - (header.box.y + header.box.height))).toBeLessThanOrEqual(1);
    if (viewport.width > 600) {
      // The foldable keeps its sidebar.
      await browserExpect(other.locator("#sidebar")).toBeVisible();
      await browserExpect(other.getByRole("button", { name: /^Menu/ })).toBeHidden();
    }
    await other.close();
  }
});
