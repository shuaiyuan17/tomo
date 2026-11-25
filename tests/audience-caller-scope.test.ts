import { describe, expect, it } from "vitest";
import { MIXED_AUDIENCE_KEY, TurnAudienceRegistry, scopedCallerKeyFor } from "../src/agent/audience.js";

// Which session a tool call made during a turn may act for (src/agent/audience.ts).
// The cron, people and todo tools all scope through it; the cron tools'
// behaviour on top of it is in cron-mcp-tools.test.ts.

// The pure half of the summoned-group fix.
describe("scopedCallerKeyFor", () => {
  const DM = "dm:alice";
  const GROUP = "telegram:-1001234567";
  const OTHER_GROUP = "telegram:-1009999999";

  it("leaves a group session alone", () => {
    expect(scopedCallerKeyFor(GROUP, ["dm"])).toBe(GROUP);
  });

  it("treats a turn with no recorded audience as the owner's", () => {
    // Cron, LCM and other background turns.
    expect(scopedCallerKeyFor(DM, undefined)).toBe(DM);
    expect(scopedCallerKeyFor(DM, [])).toBe(DM);
  });

  it("keeps a private DM turn at DM scope", () => {
    expect(scopedCallerKeyFor(DM, ["dm", "dm"])).toBe(DM);
  });

  it("narrows a summoned group's turn to that group", () => {
    expect(scopedCallerKeyFor(DM, [GROUP])).toBe(GROUP);
    expect(scopedCallerKeyFor(DM, [GROUP, GROUP])).toBe(GROUP);
  });

  it("fails closed when one turn spans several audiences", () => {
    // Picking any of them would grant the WIDEST scope on exactly the turn
    // where a group's text is in the prompt.
    expect(scopedCallerKeyFor(DM, ["dm", GROUP])).toBe(MIXED_AUDIENCE_KEY);
    expect(scopedCallerKeyFor(DM, [GROUP, OTHER_GROUP])).toBe(MIXED_AUDIENCE_KEY);
  });
});

// With `steering` on (the default) InboundBatcher dispatches a drain OUTSIDE
// the per-session queue when a live session is busy, so two runUserTurn calls
// run concurrently on one key. The audience therefore has to be tracked per
// TURN: a per-key slot let the second turn's cleanup unscope the first.
describe("TurnAudienceRegistry", () => {
  const DM = "dm:alice";
  const GROUP = "telegram:-1001234567";
  const OTHER_GROUP = "telegram:-1009999999";

  it("scopes to the session when no turn is live", () => {
    // Cron, LCM and continuity turns.
    expect(new TurnAudienceRegistry().scopedCallerKey(DM)).toBe(DM);
  });

  it("scopes a summoned-group turn to that group", () => {
    const r = new TurnAudienceRegistry();
    r.begin(DM, [GROUP]);
    expect(r.scopedCallerKey(DM)).toBe(GROUP);
  });

  // The regression this class exists for.
  it("an owner DM steer during a summoned-group turn cannot widen the group turn's scope", () => {
    const r = new TurnAudienceRegistry();
    const groupTurn = r.begin(DM, [GROUP]);
    expect(r.scopedCallerKey(DM)).toBe(GROUP);

    // config.steering: the owner's DM message runs concurrently, not queued.
    const steer = r.begin(DM, ["dm"]);
    // Two live turns that disagree — a tool call cannot be attributed to
    // either, so neither one's scope is granted.
    expect(r.scopedCallerKey(DM)).toBe(MIXED_AUDIENCE_KEY);

    // The steer finishes first. Its cleanup must not take the group turn's
    // audience with it — that was the bug, and it fell back to the session
    // key, which is the owner.
    r.end(DM, steer);
    expect(r.scopedCallerKey(DM)).toBe(GROUP);
    expect(r.scopedCallerKey(DM)).not.toBe(DM);

    r.end(DM, groupTurn);
    expect(r.scopedCallerKey(DM)).toBe(DM);
  });

  it("keeps agreeing turns unambiguous", () => {
    const r = new TurnAudienceRegistry();
    // Two DM turns overlapping is still just the owner.
    const a = r.begin(DM, ["dm"]);
    const b = r.begin(DM, ["dm"]);
    expect(r.scopedCallerKey(DM)).toBe(DM);
    // ...and two turns from the same summoned group are still that group.
    r.end(DM, a);
    r.end(DM, b);
    r.begin(DM, [GROUP]);
    r.begin(DM, [GROUP]);
    expect(r.scopedCallerKey(DM)).toBe(GROUP);
  });

  it("fails closed for two different summoned groups at once", () => {
    const r = new TurnAudienceRegistry();
    r.begin(DM, [GROUP]);
    r.begin(DM, [OTHER_GROUP]);
    expect(r.scopedCallerKey(DM)).toBe(MIXED_AUDIENCE_KEY);
  });

  it("never reads a live turn of unknown audience as 'no turn running'", () => {
    // The fail-OPEN case: an unregistered live turn would fall back to the
    // session key, which for a dm: session is the owner.
    const r = new TurnAudienceRegistry();
    r.begin(DM, undefined);
    expect(r.scopedCallerKey(DM)).toBe(MIXED_AUDIENCE_KEY);
    r.begin(DM, []);
    expect(r.scopedCallerKey(DM)).toBe(MIXED_AUDIENCE_KEY);
  });

  it("removes only its own turn, by id, when two carry equal audiences", () => {
    const r = new TurnAudienceRegistry();
    const first = r.begin(DM, [GROUP]);
    r.begin(DM, [GROUP]);
    r.end(DM, first);
    // The second is still live, so the scope is still the group.
    expect(r.scopedCallerKey(DM)).toBe(GROUP);
  });

  it("leaves a group session's own key alone however many turns overlap", () => {
    const r = new TurnAudienceRegistry();
    r.begin(GROUP, ["dm"]);
    r.begin(GROUP, [GROUP]);
    expect(r.scopedCallerKey(GROUP)).toBe(GROUP);
  });
});
