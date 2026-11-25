import { describe, it, expect } from "vitest";
import { TurnAudienceRegistry, audienceOf, audienceSwitchNote, isOwnAudienceTurn } from "../src/agent/audience.js";

const label = (a: string) => (a === "dm" ? "the private DM" : `the group ${a}`);

describe("audienceOf", () => {
  it("maps private messages to dm", () => {
    expect(audienceOf("telegram", { chatId: "111" })).toBe("dm");
    expect(audienceOf("telegram", { chatId: "111", isGroup: false })).toBe("dm");
  });

  it("maps group messages to their raw session key", () => {
    expect(audienceOf("telegram", { chatId: "-987", isGroup: true })).toBe("telegram:-987");
  });
});

describe("audienceSwitchNote", () => {
  it("is silent for the first message (no previous audience)", () => {
    expect(audienceSwitchNote(undefined, ["dm"], label)).toBe("");
    expect(audienceSwitchNote(undefined, ["telegram:-987"], label)).toBe("");
  });

  it("is silent when the audience is unchanged", () => {
    expect(audienceSwitchNote("dm", ["dm"], label)).toBe("");
    expect(audienceSwitchNote("telegram:-987", ["telegram:-987"], label)).toBe("");
  });

  it("notes a switch from DM to a group as an audience tomo-event", () => {
    const note = audienceSwitchNote("dm", ["telegram:-987"], label);
    expect(note).toMatch(/^<tomo-event type="audience" name="switch" ts="[^"]+">/);
    expect(note).toContain("Audience switched");
    expect(note).toContain("the private DM");
    expect(note).toContain("the group telegram:-987");
    expect(note.trimEnd()).toMatch(/<\/tomo-event>$/);
  });

  it("notes a switch from a group back to the DM", () => {
    const note = audienceSwitchNote("telegram:-987", ["dm"], label);
    expect(note).toContain("Audience switched");
    expect(note).toContain("this one is from the private DM");
  });

  it("notes a switch between two summoned groups", () => {
    const note = audienceSwitchNote("telegram:-987", ["telegram:-555"], label);
    expect(note).toContain("the group telegram:-987");
    expect(note).toContain("the group telegram:-555");
  });

  it("flags mixed-audience batches even without a prior audience", () => {
    const note = audienceSwitchNote(undefined, ["dm", "telegram:-987", "dm"], label);
    expect(note).toMatch(/^<tomo-event type="audience" name="check" ts="[^"]+">/);
    expect(note).toContain("Audience check");
    expect(note).toContain("the private DM");
    expect(note).toContain("the group telegram:-987");
  });

  it("handles empty input", () => {
    expect(audienceSwitchNote("dm", [], label)).toBe("");
  });
});

// The predicate that gates this session's PRIVATE surfaces — the private
// people subtree and the session transcript — for the turn in flight.
describe("isOwnAudienceTurn", () => {
  const DM = "dm:alice";
  const GROUP = "telegram:-1001234567";
  const OTHER_GROUP = "telegram:-1009999999";

  it("is true for a group session's own turn", () => {
    expect(isOwnAudienceTurn(GROUP, [GROUP])).toBe(true);
    // A group session's audience bookkeeping is DM-session-shaped; the key
    // already names the audience, so the turn is always its own.
    expect(isOwnAudienceTurn(GROUP, undefined)).toBe(true);
  });

  it("is true for the owner's own DM turn", () => {
    expect(isOwnAudienceTurn(DM, ["dm"])).toBe(true);
    expect(isOwnAudienceTurn(DM, ["dm", "dm"])).toBe(true);
  });

  it("is true for a background turn with no recorded audience", () => {
    // Cron, LCM, continuity — the owner's own, nobody else is steering.
    expect(isOwnAudienceTurn(DM, undefined)).toBe(true);
    expect(isOwnAudienceTurn(DM, [])).toBe(true);
  });

  it("is false for a summoned group's turn on the owner's DM session", () => {
    expect(isOwnAudienceTurn(DM, [GROUP])).toBe(false);
    expect(isOwnAudienceTurn(DM, [GROUP, GROUP])).toBe(false);
  });

  it("fails closed for a batch spanning several audiences", () => {
    expect(isOwnAudienceTurn(DM, ["dm", GROUP])).toBe(false);
    expect(isOwnAudienceTurn(DM, [GROUP, OTHER_GROUP])).toBe(false);
  });
});

/**
 * `turnOrigin` decides which chat `request_credential` asks on, so every way
 * it can be unsure must answer "no chat" (undefined), never a guess.
 */
describe("TurnAudienceRegistry.turnOrigin", () => {
  const KEY = "dm:alex";
  const dm = { channelName: "imessage", chatId: "any;-;+15555550123" };
  const tg = { channelName: "telegram", chatId: "1001" };

  it("is the one chat every live turn came in on, even across two turns", () => {
    const r = new TurnAudienceRegistry();
    r.begin(KEY, ["dm"], [dm]);
    r.begin(KEY, ["dm"], [dm, dm]);
    expect(r.turnOrigin(KEY)).toEqual(dm);
  });

  it("is undefined when the live turns came in on two different chats", () => {
    const r = new TurnAudienceRegistry();
    r.begin(KEY, ["dm"], [dm]);
    r.begin(KEY, ["dm"], [tg]);
    expect(r.turnOrigin(KEY)).toBeUndefined();
    // …and so is one turn whose batch spans both.
    const one = new TurnAudienceRegistry();
    one.begin(KEY, ["dm"], [dm, tg]);
    expect(one.turnOrigin(KEY)).toBeUndefined();
  });

  it("is undefined with no live turn (cron, heartbeat), and when a live turn has no origin", () => {
    const r = new TurnAudienceRegistry();
    expect(r.turnOrigin(KEY)).toBeUndefined();
    r.begin(KEY, ["dm"], [dm]);
    // A delegated or background turn registered beside it: nobody can say
    // which of the two is calling.
    r.begin(KEY, ["dm"]);
    expect(r.turnOrigin(KEY)).toBeUndefined();
  });

  it("forgets a turn's origin when it ends, and answers per session", () => {
    const r = new TurnAudienceRegistry();
    const a = r.begin(KEY, ["dm"], [dm]);
    const b = r.begin(KEY, ["dm"], [tg]);
    r.begin("telegram:-100", ["telegram:-100"], [{ channelName: "telegram", chatId: "-100" }]);
    r.end(KEY, b);
    expect(r.turnOrigin(KEY)).toEqual(dm);
    r.end(KEY, a);
    expect(r.turnOrigin(KEY)).toBeUndefined();
    expect(r.turnOrigin("telegram:-100")).toEqual({ channelName: "telegram", chatId: "-100" });
  });

  it("hands out a copy, so a caller cannot change what is recorded", () => {
    const r = new TurnAudienceRegistry();
    const origin = { ...dm };
    r.begin(KEY, ["dm"], [origin]);
    origin.chatId = "changed";
    r.turnOrigin(KEY)!.chatId = "changed too";
    expect(r.turnOrigin(KEY)).toEqual(dm);
  });
});

describe("TurnAudienceRegistry.liveTurnIds / isLive", () => {
  it("lists a session's live turns, with ids unique across sessions and never reused", () => {
    const r = new TurnAudienceRegistry();
    const a = r.begin("dm:alex", ["dm"]);
    const b = r.begin("telegram:-100", ["telegram:-100"]);
    const c = r.begin("dm:alex", ["dm"]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(r.liveTurnIds("dm:alex")).toEqual([a, c]);
    expect(r.liveTurnIds("telegram:-100")).toEqual([b]);
    expect(r.liveTurnIds("dm:nobody")).toEqual([]);

    r.end("dm:alex", a);
    expect(r.liveTurnIds("dm:alex")).toEqual([c]);
    expect(r.isLive(a)).toBe(false);
    expect(r.isLive(b)).toBe(true);
    expect(r.isLive(c)).toBe(true);

    // A new turn never takes an ended turn's id.
    expect(r.begin("dm:alex", ["dm"])).not.toBe(a);
  });
});
