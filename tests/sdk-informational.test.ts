import { describe, expect, it, vi } from "vitest";
import type { SDKInformationalMessage } from "@anthropic-ai/claude-agent-sdk";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { InformationalNotices, INFORMATIONAL_NOTICE_INTERVAL_MS } = await import("../src/agent/sdk-informational.js");

function message(tag: string | undefined, content = "callback threw"): SDKInformationalMessage {
  return {
    type: "system", subtype: "informational", level: "warning", content,
    uuid: "00000000-0000-0000-0000-000000000000" as SDKInformationalMessage["uuid"], session_id: "s1",
    ...(tag !== undefined ? { tag } : {}),
  };
}

function setup(delivered = true) {
  let now = 1_000_000;
  const sent: string[] = [];
  const notifyOwner = vi.fn(async (text: string) => { sent.push(text); return delivered; });
  const notices = new InformationalNotices({ notifyOwner, now: () => now });
  return { notices, sent, notifyOwner, advance: (ms: number) => { now += ms; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("InformationalNotices", () => {
  it("hook_callback_failed: one owner notice, and no repeat within the hour", async () => {
    const { notices, sent, advance } = setup();
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("dm:owner");
    expect(sent[0]).toContain("callback threw");
    notices.observe("dm:owner", message("hook_callback_failed"));
    advance(INFORMATIONAL_NOTICE_INTERVAL_MS - 1);
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(1);
    advance(1);
    notices.observe("dm:owner", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(2);
  });

  it("dedupes per tag and per session", async () => {
    const { notices, sent } = setup();
    notices.observe("dm:owner", message("hook_callback_failed"));
    notices.observe("dm:owner", message("settings_not_in_effect"));
    notices.observe("telegram:-100", message("hook_callback_failed"));
    await flush();
    expect(sent).toHaveLength(3);
  });

  it("unknown or missing tag: no notice (logged only by the session)", async () => {
    const { notices, notifyOwner } = setup();
    notices.observe("dm:owner", message("managed_hooks_not_loaded"));
    notices.observe("dm:owner", message(undefined));
    await flush();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("an undelivered notice frees the slot for the next one", async () => {
    const { notices, notifyOwner } = setup(false);
    notices.observe("dm:owner", message("settings_not_in_effect"));
    await flush();
    notices.observe("dm:owner", message("settings_not_in_effect"));
    await flush();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });
});
