import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from "../src/logger.js";
import { BlockedInboundLog, redactChatIdForLog } from "../src/agent/blocked-inbound-log.js";

describe("BlockedInboundLog", () => {
  it("logs a refused chat once per interval, at info, with only the id's tail", () => {
    let now = 0;
    const blocked = new BlockedInboundLog(60_000, () => now);
    blocked.record("imessage", "any;-;+15555550123", false);
    blocked.record("imessage", "any;-;+15555550123", false);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields] = vi.mocked(log.info).mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields).toEqual({ channel: "imessage", chat: "…0123" });
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("5555550123");

    // A different chat is logged on its own.
    blocked.record("imessage", "any;-;+15555550199", false);
    expect(log.info).toHaveBeenCalledTimes(2);

    // After the interval the first chat is logged again.
    now = 60_001;
    blocked.record("imessage", "any;-;+15555550123", false);
    expect(log.info).toHaveBeenCalledTimes(3);
  });

  it("redacts short ids without padding", () => {
    expect(redactChatIdForLog("12")).toBe("12");
    expect(redactChatIdForLog("123456789")).toBe("…6789");
  });
});
