import { describe, expect, it } from "vitest";
import { awaitingOwner, dismissAfterAcceptedSend, historyBadge, isResendOf, MAX_KEPT_REQUESTS, pendingLabel, pendingUserMessages, readReceipt, recordedReplyIds, resendAfterDraftChange, trimRequests } from "../web/src/pending.js";
import { readReceiptLabel } from "../web/src/read-receipt.js";
import type { HistoryMessage, HistoryPage, WebRequest } from "../src/web/protocol.js";

const message = (id: string, extra: Partial<HistoryMessage>): HistoryMessage =>
  ({ id, role: "user", content: id, channel: "web", timestamp: 0, ...extra });
const page = (...messages: HistoryMessage[]): HistoryPage => ({ messages, nextCursor: null });
const request = (requestId: string, extra: Partial<WebRequest> = {}): WebRequest =>
  ({ requestId, state: "queued", sessionId: "owner", text: `text of ${requestId}`, ...extra });

describe("pending owner bubbles (#381)", () => {
  it("keeps an interrupted message's bubble (its excerpt) until the transcript shows it", () => {
    expect(pendingUserMessages([request("i", { state: "interrupted" })], page(), "owner").map((r) => r.requestId)).toEqual(["i"]);
  });
  it("shows a queued message the transcript does not record yet, until it does", () => {
    const requests = [request("a"), request("b", { state: "running" })];
    expect(pendingUserMessages(requests, page(), "owner").map((r) => r.requestId)).toEqual(["a", "b"]);
    expect(pendingUserMessages(requests, page(message("m1", { requestId: "a" })), "owner").map((r) => r.requestId)).toEqual(["b"]);
  });

  it("hides refused, text-less (settled) and other-session requests", () => {
    const requests = [request("r", { state: "refused" }), request("s", { text: undefined, state: "completed" }), request("g", { sessionId: "group" })];
    expect(pendingUserMessages(requests, page(), "owner")).toEqual([]);
  });

  it("a recorded reply covers its own request and every request that joined its turn", () => {
    const ids = recordedReplyIds(page(message("u", { requestId: "x" }), message("r", { role: "assistant", requestId: "first", turnId: "turn-1" })));
    expect([...ids].sort()).toEqual(["first", "turn-1"]);
  });

  it("badges every recorded bubble whose own request was interrupted or uncertain, by requestId", () => {
    const requests = [request("a", { state: "interrupted", text: undefined }), request("b", { state: "completed", text: undefined }),
      request("c", { state: "unknown", text: undefined }), request("d", { state: "interrupted", text: undefined })];
    expect(["a", "b", "c", "d", undefined].map((id) => historyBadge(id, requests))).toEqual(["Interrupted", undefined, "Outcome unknown", "Interrupted", undefined]);
    expect(historyBadge("zzz", requests)).toBeUndefined();
  });
  it("only an interrupted request that still has its text can be resent or dismissed", () => {
    expect(awaitingOwner(request("i", { state: "interrupted" }))).toBe(true);
    expect(awaitingOwner(request("i", { state: "interrupted", text: undefined }))).toBe(false);
    expect(awaitingOwner(request("q"))).toBe(false);
  });
  it("labels a joined request by the join, others by state", () => {
    expect(pendingLabel(request("j", { joined: true, state: "running" }))).toBe("Joined the running turn");
    expect(pendingLabel(request("q"))).toBe("Queued");
    expect(pendingLabel(request("i", { state: "interrupted" }))).toMatch(/Interrupted by a restart/);
    expect(pendingLabel(request("u", { state: "unknown" }))).toMatch(/may have run/);
  });
});

describe("request list bounds", () => {
  it("trims settled requests but never one in flight or awaiting the owner", () => {
    const awaiting = Array.from({ length: 70 }, (_, i) => request(`i${i}`, { state: "interrupted" }));
    const settled = Array.from({ length: 300 }, (_, i) => request(`s${i}`, { state: "completed", text: undefined }));
    const live = [request("q"), request("r", { state: "running" })];
    const kept = trimRequests([...awaiting, ...settled, ...live]);
    expect(awaiting.every((r) => kept.includes(r))).toBe(true);
    expect(live.every((r) => kept.includes(r))).toBe(true);
    expect(kept.filter((r) => r.state === "completed")).toEqual(settled.slice(-MAX_KEPT_REQUESTS));
  });
});

describe("resending an interrupted message", () => {
  const resend = { requestId: "old", original: "Please book the restaurant for Friday at seven for four people" };
  it("dismisses the original only after the same message, or an edit of it, is accepted", () => {
    expect(dismissAfterAcceptedSend(resend, resend.original)).toBe("old");
    expect(dismissAfterAcceptedSend(resend, "Please book the restaurant for Saturday at seven for four people")).toBe("old");
    expect(dismissAfterAcceptedSend(resend, "What's the weather tomorrow?")).toBeNull();
    expect(dismissAfterAcceptedSend(null, resend.original)).toBeNull();
  });
  it("is cancelled when the draft is cleared, kept while it is edited", () => {
    expect(resendAfterDraftChange(resend, "   ")).toBeNull();
    expect(resendAfterDraftChange(resend, "Please book")).toBe(resend);
  });
  it("compares characters for short or unspaced text (e.g. Chinese)", () => {
    expect(isResendOf("帮我订周五晚上七点的餐厅", "帮我订周六晚上七点的餐厅")).toBe(true);
    expect(isResendOf("帮我订周五晚上七点的餐厅", "明天天气怎么样")).toBe(false);
  });
});

describe("read receipts", () => {
  it("queued → sent → read, in the order a message lives through them", () => {
    let r = request("a");
    expect(readReceipt("a", [r])).toBe("queued");
    r = { ...r, state: "running", handedOff: true };
    expect(readReceipt("a", [r])).toBe("sent");
    r = { ...r, read: true };
    expect(readReceipt("a", [r])).toBe("read");
    expect(readReceipt("a", [{ ...r, state: "completed" }])).toBe("read");
  });
  it("a joined message is sent, not queued; an old SDK leaves a completed message at sent", () => {
    expect(readReceipt("a", [request("a", { joined: true })])).toBe("sent");
    expect(readReceipt("a", [request("a", { state: "completed" })])).toBe("sent");
  });
  it("history this page has no request for counts as read; no request id, no receipt", () => {
    expect(readReceipt("gone", [request("a")])).toBe("read");
    expect(readReceipt(undefined, [])).toBeUndefined();
  });
  it("a request that did not end cleanly shows no receipt (its badge speaks)", () => {
    for (const state of ["failed", "refused", "unknown", "interrupted"] as const) expect(readReceipt("a", [request("a", { state })])).toBeUndefined();
  });
  it("labels name the agent", () => {
    expect(readReceiptLabel("read", "Claw")).toBe("Read by Claw");
    expect(readReceiptLabel("sent", "Claw")).toBe("Sent");
  });
});
