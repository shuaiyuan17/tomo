import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chromium, devices, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/config.js", async () => (await import("../helpers/agent-mocks.js")).configModuleMock());
vi.mock("../../src/workspace/index.js", async () => (await import("../helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("../helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../../src/logger.js", async () => (await import("../helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockConfig, mockSdk } from "../helpers/agent-harness.js";
import { WebChannel } from "../../src/channels/web.js";
import { WebSupervisor } from "../../src/web/supervisor.js";
import { watchBus } from "../../src/watch/bus.js";

installAgentTestHooks();
let agent: Agent;
let channel: WebChannel;
let supervisor: WebSupervisor;
let browser: Browser;
let url: string;
let rewindPreview = "";
beforeEach(async () => {
  watchBus.reset();
  mockConfig.identities = [{ name: "owner", channels: { telegram: "test-owner" }, replyPolicy: "last-active" }];
  agent = new Agent();
  channel = new WebChannel(mockConfig.owner, undefined, { stop: (key) => agent.stopTurn(key), model: (key) => agent.modelFor(key),
    models: { view: (key) => agent.webModelView(key), switch: (key, model, from) => agent.switchModelFromWeb(key, model, from) },
    // The fork itself is covered in tests/web-rewind.test.ts; here the SDK's preview is whatever the test says it would cut at.
    rewind: async (_key, count, matches) => matches(rewindPreview) ? { ok: true, count, preview: rewindPreview } : { ok: false, reason: "rewind_mismatch" } });
  supervisor = new WebSupervisor(channel, { ...mockConfig, owner: mockConfig.owner, port: 0 });
  channel.attach(supervisor); agent.addChannel(channel); agent.addChannel(new MockChannel("telegram"));
  await channel.start();
  url = `http://127.0.0.1:${supervisor.status().port}`;
  browser = await chromium.launch();
  mkdirSync("test-results", { recursive: true });
});
afterEach(async () => { await browser?.close(); await agent.stop(); });

async function open(options: Parameters<Browser["newPage"]>[0]): Promise<Page> {
  const page = await browser.newPage(options);
  await page.goto(`${url}/?t=${readFileSync(resolve(mockConfig.tomoHome, "web-token"), "utf8").trim()}`);
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toBeEnabled();
  return page;
}
/** A turn that stays running until `release` is called. */
function heldTurn() {
  let release!: (text: string) => void;
  const done = new Promise<string>((r) => { release = r; });
  mockSdk.responseFn = () => done;
  return release;
}

it("shows what the SDK reports about a running turn, stops it, and offers the next prompt", async () => {
  const page = await open({ viewport: { width: 1440, height: 900 } });
  const status = page.locator(".feedback");
  const release = heldTurn();
  await browserExpect(page.getByRole("link", { name: /^Model: / })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("Do the long thing.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop Tomo" });
  await browserExpect(stop).toBeVisible();
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  const sdk = mockSdk.queryControllers.at(-1)!;

  sdk.pushEvent({ type: "system", subtype: "init", model: "claude-opus-5-5[1m]" });
  await browserExpect(page.getByRole("link", { name: "Model: claude-opus-5-5[1m]. Open model settings" })).toHaveText("Opus 5.5");
  sdk.pushEvent({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded" });
  await browserExpect(status).toHaveText("Tomo is working… Retrying 2/10 · claude is overloaded");
  sdk.pushEvent({ type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 42 });
  await browserExpect(status).toHaveText(/^Tomo is working… Bash · 4\ds$/);
  sdk.pushEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.91, resetsAt: Math.floor(Date.now() / 1000) + 7200 } });
  await browserExpect(page.getByText(/^5-hour limit almost reached · 91% · resets in/)).toBeVisible();
  await page.screenshot({ path: "test-results/turn-running-desktop.png" });

  // Typing a follow-up brings Send back (it joins or queues); clearing it brings Stop back.
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("also");
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("");
  await stop.click();
  await browserExpect(status).toHaveText("Stopped");
  expect(mockSdk.interrupts).toBe(1);
  await browserExpect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  release("never delivered");

  sdk.pushEvent({ type: "prompt_suggestion", suggestion: "[web · Wed 09/02 20:50 PDT] Try it again, smaller." });
  const chip = page.getByRole("button", { name: "Try it again, smaller." });
  await chip.click();
  await browserExpect(page.getByRole("textbox", { name: "Message Tomo" })).toHaveValue("Try it again, smaller.");
  await browserExpect(chip).toHaveCount(0);
  await browserExpect(page.getByText("never delivered")).toHaveCount(0);
  // The stopped turn said nothing: history says so, not "NO_REPLY" in the agent's voice.
  await browserExpect(page.locator(".message.assistant")).toHaveText(/No reply$/);

  // The badge leads to the Study's Model page.
  await page.getByRole("link", { name: /^Model: / }).click();
  await browserExpect(page).toHaveURL(/#study\/model$/);
  await browserExpect(page.getByRole("tab", { name: "Model" })).toHaveAttribute("aria-selected", "true");
  await browserExpect(page.getByText("claude-sonnet-5[1m]").first()).toBeVisible();
  await page.screenshot({ path: "test-results/study-model-desktop.png" });
});

it("names a typed API error instead of a bare failure, until the next message", async () => {
  const page = await open({ viewport: { width: 1280, height: 800 } });
  const release = heldTurn();
  await page.getByRole("textbox", { name: "Message Tomo" }).fill("Hello?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await browserExpect(page.getByRole("button", { name: "Stop Tomo" })).toBeVisible();
  mockSdk.queryControllers.at(-1)!.pushEvent({ type: "assistant", error: "authentication_failed", parent_tool_use_id: null, message: { content: [] } });
  mockSdk.nextResult = { is_error: true, result: "API Error: 401 authentication_error" };
  release("");
  await browserExpect(page.locator(".feedback")).toHaveText("Claude login expired. Send /login to sign in again — not answered");
});

it("on a phone: no zoom-triggering fields, a compact header, and the view follows a picture once it loads", async () => {
  const page = await open({ ...devices["iPhone 14"], defaultBrowserType: undefined });
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  // iOS Safari zooms the page for any focused field under 16px.
  await page.evaluate(() => { window.location.hash = "study/model"; });
  await browserExpect(page.getByRole("tab", { name: "Model" })).toBeVisible();
  const sizes = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((element) => parseFloat(getComputedStyle(element).fontSize)));
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
  await browserExpect(page.getByRole("textbox", { name: /model/i })).toBeVisible();
  await page.screenshot({ path: "test-results/study-model-phone.png" });
  await page.evaluate(() => { window.location.hash = ""; });
  await browserExpect(input).toBeVisible();
  expect((await page.locator("header").boundingBox())!.height).toBeLessThan(52);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  let answers = 0;
  mockSdk.responseFn = () => `Answer ${++answers}.\n\n${"A line of the answer.\n\n".repeat(12)}`;
  for (const [index, text] of ["First question", "Second question"].entries()) {
    await input.fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect(page.locator(".message.assistant").filter({ hasText: `Answer ${index + 1}.` })).toBeVisible();
  }
  const scroller = page.getByLabel("Conversation history");
  const gap = () => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  // Each question anchored near the top, its answer below it; the reader goes on to the end.
  await scroller.focus();
  await page.keyboard.press("End");
  await browserExpect.poll(gap).toBeLessThan(2);
  // A picture has no height until it loads: the reader, at the end, must stay at the end.
  await scroller.evaluate((element) => {
    const image = document.createElement("img");
    image.alt = "late";
    image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="gray"/></svg>')}`;
    [...element.querySelectorAll("article.message")].at(-1)!.appendChild(image);
  });
  await browserExpect.poll(() => scroller.evaluate((element) => (element.querySelector('img[alt="late"]') as HTMLImageElement).naturalHeight)).toBe(400);
  await browserExpect.poll(gap).toBeLessThan(2);
  await scroller.evaluate((element) => element.querySelector('img[alt="late"]')!.remove());
  await page.screenshot({ path: "test-results/chat-phone.png" });
  await input.focus();
  await page.screenshot({ path: "test-results/chat-phone-focused.png" });
});

it("rewinds to one of the owner's messages: confirm, marker, the message back in the composer; a mismatch changes nothing", async () => {
  const page = await open({ viewport: { width: 1440, height: 900 } });
  const input = page.getByRole("textbox", { name: "Message Tomo" });
  let answers = 0;
  mockSdk.responseFn = () => `Answer ${++answers}.`;
  for (const [index, text] of ["Plan the trip to Kyoto", "Make it five days", "Add a day in Nara"].entries()) {
    await input.fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect(page.locator(".message.assistant").filter({ hasText: `Answer ${index + 1}.` })).toBeVisible();
  }
  const second = page.locator(".message.user").filter({ hasText: "Make it five days" });
  const rewindButton = second.getByRole("button", { name: "Rewind the conversation to before this message" });
  // Replies have no rewind control.
  await browserExpect(page.locator(".message.assistant").getByRole("button", { name: /Rewind the conversation/ })).toHaveCount(0);

  // The SDK would cut somewhere else: refused, nothing marked.
  rewindPreview = "[web · Sun 11/15 04:20 UTC] Some other message";
  await second.hover(); await rewindButton.click();
  await browserExpect(second.getByRole("group", { name: "Confirm rewind" })).toContainText("everything after it (2 of your messages)");
  await second.getByRole("button", { name: "Rewind", exact: true }).click();
  await browserExpect(page.locator(".feedback")).toContainText("Not rewound: this message does not line up");
  await browserExpect(page.getByRole("separator").filter({ hasText: "Rewound from here" })).toHaveCount(0);

  rewindPreview = "[web · Sun 11/15 04:20 UTC] Make it five days";
  await second.hover(); await rewindButton.click();
  await second.getByRole("button", { name: "Rewind", exact: true }).click();
  await browserExpect(page.locator(".feedback")).toContainText("Rewound. Tomo no longer has this message");
  await browserExpect(input).toHaveValue("Make it five days");
  await browserExpect(page.getByRole("separator").filter({ hasText: "Rewound from here" })).toHaveCount(1);
  // What was rewound stays readable but can no longer be rewound to; what came before still can.
  await browserExpect(second.getByRole("button", { name: /Rewind the conversation/ })).toHaveCount(0);
  await browserExpect(page.locator(".message.user").filter({ hasText: "Plan the trip to Kyoto" }).getByRole("button", { name: /Rewind the conversation/ })).toHaveCount(1);
  await page.screenshot({ path: "test-results/rewind-desktop.png" });
  // The mark comes from the daemon, so a reload keeps it.
  await page.reload();
  await browserExpect(page.getByRole("separator").filter({ hasText: "Rewound from here" })).toHaveCount(1);
});
