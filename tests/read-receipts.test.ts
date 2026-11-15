import { describe, expect, it } from "vitest";
import { consumedUuidsOf, ReadReceiptTracker } from "../src/agent/read-receipts.js";

describe("read receipts tracker", () => {
  it("reads user_message_uuids, falls back to user_message_uuid, and tolerates neither", () => {
    expect(consumedUuidsOf({ user_message_uuids: ["a", "b"], user_message_uuid: "b" })).toEqual(["a", "b"]);
    expect(consumedUuidsOf({ user_message_uuid: "a" })).toEqual(["a"]);
    expect(consumedUuidsOf({ type: "assistant" })).toEqual([]);
    expect(consumedUuidsOf({ user_message_uuids: "nope" })).toEqual([]);
    expect(consumedUuidsOf(null)).toEqual([]);
  });
  it("reports each tracked uuid once, in consumption order, with its request id", () => {
    const t = new ReadReceiptTracker();
    t.track("a", "req-a"); t.track("b"); t.track("c", "req-c");
    expect(t.consume({ user_message_uuids: ["c", "a", "x"] })).toEqual({ uuids: ["c", "a"], requestIds: ["req-c", "req-a"] });
    expect(t.consume({ user_message_uuids: ["a", "c"] })).toBeNull();
    expect(t.consume({ user_message_uuids: ["a", "b"] })).toEqual({ uuids: ["b"], requestIds: [] });
  });
  it("forgets the oldest unread uuid past its cap", () => {
    const t = new ReadReceiptTracker(2);
    t.track("a"); t.track("b"); t.track("c");
    expect(t.consume({ user_message_uuids: ["a", "b", "c"] })?.uuids).toEqual(["b", "c"]);
  });
});
