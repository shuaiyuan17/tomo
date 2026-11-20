import { describe, expect, it } from "vitest";
import type { HistoryMessage, HistoryPage } from "../src/web/protocol.js";
import { mergeLatest, mergeOlder } from "../web/src/use-history.js";
import { parseHistory } from "../web/src/conversation-rows.js";
import { reactFailure, sendFailure } from "../web/src/composer.js";
import { deferred, say } from "../web/src/i18n/message.js";
import { ApiError } from "../web/src/api.js";

const msg = (id: string, content = id, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ id, role: "user", content, channel: "web", timestamp: Number(id.replace(/\D/g, "")) || 1, ...extra });
const page = (messages: HistoryMessage[], extra: Partial<HistoryPage> = {}): HistoryPage => ({ messages, nextCursor: null, revision: "r1", ...extra });

describe("history merges keep unchanged messages, so memoized rows can skip them", () => {
  it("a re-read that changed nothing returns the loaded page itself", () => {
    const old = page([msg("m1"), msg("m2")]);
    // Fresh objects from JSON, equal in content.
    expect(mergeLatest(old, page([msg("m1"), msg("m2")]))).toBe(old);
  });
  it("a new message is appended; the unchanged ones keep their identity, a changed one is replaced", () => {
    const old = page([msg("m1"), msg("m2")]);
    const next = mergeLatest(old, page([msg("m1"), msg("m2", "edited"), msg("m3")]));
    expect(next.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.messages[0]).toBe(old.messages[0]);
    expect(next.messages[1]).not.toBe(old.messages[1]);
    expect(next.messages[1].content).toBe("edited");
  });
  it("keeps older loaded pages (and their cursor) when the latest page is read again", () => {
    const loaded = Array.from({ length: 120 }, (_, i) => msg(`m${i + 1}`));
    const old = page(loaded, { nextCursor: "older" });
    const next = mergeLatest(old, page([...loaded.slice(-100).map((m) => ({ ...m })), msg("m121")], { nextCursor: "latest" }));
    expect(next.messages).toHaveLength(121);
    expect(next.nextCursor).toBe("older");
    expect(next.messages.slice(0, 120).every((m, i) => m === loaded[i])).toBe(true);
  });
  it("a rewritten history (new revision) replaces what was loaded", () => {
    const old = page([msg("m1")]);
    const fresh = page([msg("m9")], { revision: "r2" });
    expect(mergeLatest(old, fresh)).toBe(fresh);
  });
  it("an older page goes in front, without duplicates", () => {
    const old = page([msg("m3"), msg("m4")], { nextCursor: "c1" });
    const next = mergeOlder(old, page([msg("m1"), msg("m2"), msg("m3")], { nextCursor: null }));
    expect(next.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(next.messages[2]).toBe(old.messages[0]);
    expect(next.nextCursor).toBeNull();
  });
});

describe("parseHistory", () => {
  it("parses each message object once and finds the message a reply quotes", () => {
    const original = msg("m1", "The plan for Tuesday", { role: "assistant" });
    const reply = msg("m2", "[replying to: \"The plan for Tuesday\"] Sounds good");
    const first = parseHistory([original, reply]);
    expect(first[1].quotedId).toBe("m1");
    expect(first[1].parsed.body).toBe("Sounds good");
    // The same message objects (a history that kept them): the same parsed objects.
    const again = parseHistory([original, reply]);
    expect(again[0].parsed).toBe(first[0].parsed);
    expect(again[1].parsed).toBe(first[1].parsed);
  });
});

describe("send and reaction failures", () => {
  const unknown = deferred.t("chat:request.unknown", { agent: "Tomo" });
  it("a named refusal is definite: the draft is kept, nothing is left to check", () => {
    const backlog = sendFailure(new ApiError(503, "interrupted_backlog"), unknown);
    expect(backlog).toMatchObject({ definite: true, warn: true });
    expect(say(backlog.text)).toContain("your draft is kept");
    const large = sendFailure(new ApiError(413, "too_large"), unknown);
    expect(large.definite).toBe(true);
    expect(say(large.text)).toContain("too large");
    // A group is read-only by design: said plainly, not as a warning.
    const group = sendFailure(new ApiError(403, "owner_dm_only"), unknown);
    expect({ ...group, text: say(group.text) }).toEqual({ definite: true, warn: false, text: "Group conversations are read-only." });
  });
  it("anything else may have arrived: the request stays uncertain and the owner checks", () => {
    expect(sendFailure(new TypeError("network"), unknown)).toEqual({ definite: false, warn: true, text: unknown });
    expect(sendFailure(new ApiError(500, "unavailable"), unknown).definite).toBe(false);
  });
  it("a reaction has no draft to keep", () => {
    const react = (err: unknown) => say(reactFailure(err));
    expect(react(new ApiError(503, "interrupted_backlog"))).toContain("; the reaction was not sent.");
    expect(react(new ApiError(503, "persist_failed"))).toBe("Not sent: Tomo could not record the message safely. The reaction was not sent; try again.");
    for (const code of ["interrupted_backlog", "journal_unavailable", "persist_failed"]) expect(react(new ApiError(503, code))).not.toMatch(/draft/i);
    expect(react(new ApiError(409, "epoch_changed"))).toBe("Reaction was not sent. Reconnect or try again.");
    expect(react(new TypeError("network"))).toMatch(/may not have been sent/);
  });
});
