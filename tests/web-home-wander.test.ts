import { describe, expect, it } from "vitest";
import type { HomeWander } from "../src/home/scene.js";
import { WANDER_EVERY_DEFAULT } from "../web/src/home/contract.js";
import { pickNext, placeCharacter, seeded, startWander, stayFor, stepWander, wanders, type Wanderer, type WanderState } from "../web/src/home/wander.js";

const WANDER: HomeWander = { spots: ["cushion", "window", "pool-side", "bookshelf"], every: [30, 90] };
const CRAB: Wanderer = { spot: "cushion", rules: [{ when: "by:heartbeat", spot: "window" }, { when: "working", spot: "desk-chair" }], wander: WANDER };
const IDLE = new Set(["idle", "day"]);
const WORKING = new Set(["working", "by:owner", "day"]);

/** A fake clock driving the wander: each time its stay is over, the next step (travel is 4 s every time). */
function stroll(seed: number, steps: number, wander = WANDER, allowed?: (from: string, to: string) => boolean) {
  const random = seeded(seed);
  let state: WanderState = startWander(wander, "cushion", 0, random);
  const out = [{ ...state, now: 0 }];
  for (let i = 0; i < steps; i++) {
    const now = state.leaveAt;
    state = stepWander(state, wander, now, random, { allowed, travel: () => 4 });
    out.push({ ...state, now });
  }
  return out;
}

describe("wander: the dice and the clock are the caller's", () => {
  it("the same seed gives the same numbers; another seed others", () => {
    const a = seeded(7), b = seeded(7), c = seeded(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const x of first) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });

  it("with a fixed seed and a fake clock: which spot next, and when", () => {
    const steps = stroll(42, 4).map((s) => ({ spot: s.spot, now: Math.round(s.now * 100) / 100, leaveAt: Math.round(s.leaveAt * 100) / 100 }));
    expect(steps).toMatchInlineSnapshot(`
      [
        {
          "leaveAt": 66.07,
          "now": 0,
          "spot": "cushion",
        },
        {
          "leaveAt": 151.21,
          "now": 66.07,
          "spot": "pool-side",
        },
        {
          "leaveAt": 195.7,
          "now": 151.21,
          "spot": "bookshelf",
        },
        {
          "leaveAt": 246.1,
          "now": 195.7,
          "spot": "window",
        },
        {
          "leaveAt": 332.03,
          "now": 246.1,
          "spot": "pool-side",
        },
      ]
    `);
  });

  it("stays a time within [shortest, longest] at each spot, after the walk there; [30, 90] when the scene gives none", () => {
    expect(WANDER_EVERY_DEFAULT).toEqual([30, 90]);
    const random = seeded(1);
    for (let i = 0; i < 500; i++) {
      const own = stayFor([30, 90], random), fallback = stayFor(undefined, random), fixed = stayFor([12, 12], random);
      expect(own).toBeGreaterThanOrEqual(30); expect(own).toBeLessThanOrEqual(90);
      expect(fallback).toBeGreaterThanOrEqual(30); expect(fallback).toBeLessThanOrEqual(90);
      expect(fixed).toBe(12);
    }
    const steps = stroll(3, 300);
    for (let i = 1; i < steps.length; i++) {
      const stay = steps[i].leaveAt - steps[i].now - 4;
      expect(stay).toBeGreaterThanOrEqual(30);
      expect(stay).toBeLessThanOrEqual(90);
    }
  });

  it("does nothing before its stay is over", () => {
    const random = seeded(5);
    const state = startWander(WANDER, "cushion", 100, random);
    expect(state.spot).toBe("cushion");
    expect(stepWander(state, WANDER, state.leaveAt - 0.01, random)).toBe(state);
    expect(stepWander(state, WANDER, state.leaveAt, random).spot).not.toBe("cushion");
  });

  it("never picks the spot it is at twice in a row, and gets round all of them", () => {
    for (const seed of [1, 2, 3, 99]) {
      const steps = stroll(seed, 400);
      for (let i = 1; i < steps.length; i++) expect(steps[i].spot).not.toBe(steps[i - 1].spot);
      const counts = new Map<string, number>();
      for (const s of steps) counts.set(s.spot, (counts.get(s.spot) ?? 0) + 1);
      expect([...counts.keys()].sort()).toEqual([...WANDER.spots].sort());
      // Even among the other three: each about a quarter of the time.
      for (const n of counts.values()) expect(n).toBeGreaterThan(60);
    }
    // A spot listed twice is still only one of the choices.
    expect(stroll(4, 50, { spots: ["a", "b", "b"] }).every((s, i, all) => i === 0 || s.spot !== all[i - 1].spot)).toBe(true);
  });

  it("never goes where it may not (cannot walk there, or someone else is there); with nowhere to go it stays another while", () => {
    const blocked = (from: string, to: string) => to !== "bookshelf" && !(from === "cushion" && to === "window");
    const steps = stroll(11, 200, WANDER, blocked);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].spot).not.toBe("bookshelf");
      if (steps[i - 1].spot === "cushion") expect(steps[i].spot).toBe("pool-side");
    }
    const random = seeded(2);
    const stuck = stepWander({ spot: "cushion", leaveAt: 10 }, WANDER, 10, random, { allowed: () => false });
    expect(stuck.spot).toBe("cushion");
    expect(stuck.leaveAt).toBeGreaterThanOrEqual(40);
    expect(pickNext(["a"], "a", random)).toBeUndefined();
  });

  it("when the page opens, it is put straight at one of its wander spots it can get to from its own", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      const state = startWander(WANDER, "cushion", 0, seeded(seed), { first: true, allowed: (_from, to) => to !== "window" });
      seen.add(state.spot);
      expect(state.leaveAt).toBeGreaterThanOrEqual(30);
    }
    expect([...seen].sort()).toEqual(["bookshelf", "cushion", "pool-side"]);
  });

  it("the first placement keeps to the same rules as every step: not even its own spot when someone else is there", () => {
    const taken = new Set(["cushion", "window"]);
    for (let seed = 0; seed < 100; seed++) {
      const state = startWander(WANDER, "cushion", 0, seeded(seed), { first: true, allowed: (_from, to) => !taken.has(to) });
      expect(["pool-side", "bookshelf"]).toContain(state.spot);
    }
  });
});

describe("wander: rules come first, and only some times", () => {
  const options = { tomo: true, reduced: false };

  it("a rule interrupts a stroll at once; when it ends, it stays once where it is, then wanders on", () => {
    const random = seeded(9);
    let placing = placeCharacter(CRAB, IDLE, null, 0, random, { ...options, at: "cushion" });
    expect(placing).toMatchObject({ spot: "cushion", by: "wander" });
    // Its stay is over: off to another spot (walking there now).
    const leaving = placing.wander!.leaveAt;
    placing = placeCharacter(CRAB, IDLE, placing.wander, leaving, random, { ...options, at: placing.spot });
    expect(placing.by).toBe("wander");
    expect(placing.spot).not.toBe("cushion");
    // Mid-walk, the owner writes: to the desk, and the wander is dropped.
    placing = placeCharacter(CRAB, WORKING, placing.wander, leaving + 1, random, { ...options, at: placing.spot });
    expect(placing).toEqual({ spot: "desk-chair", by: "rule", wander: null });
    // A heartbeat (a running turn too): its own rule, no wandering.
    expect(placeCharacter(CRAB, new Set(["working", "by:heartbeat"]), null, leaving + 2, random, { ...options, at: "desk-chair" })).toEqual({ spot: "window", by: "rule", wander: null });
    // The turn ends: it stays at the desk once, then wanders from there.
    placing = placeCharacter(CRAB, IDLE, null, 500, random, { ...options, at: "desk-chair" });
    expect(placing.spot).toBe("desk-chair");
    expect(placing.wander!.leaveAt - 500).toBeGreaterThanOrEqual(30);
    expect(placing.wander!.leaveAt - 500).toBeLessThanOrEqual(90);
    placing = placeCharacter(CRAB, IDLE, placing.wander, placing.wander!.leaveAt, random, { ...options, at: "desk-chair" });
    expect(WANDER.spots).toContain(placing.spot);
  });

  it("Tomo wanders only while idle, even with no rule holding", () => {
    const noRules: Wanderer = { spot: "cushion", wander: WANDER };
    expect(placeCharacter(noRules, new Set(["working", "day"]), { spot: "window", leaveAt: 0 }, 10, seeded(1), options)).toEqual({ spot: "cushion", by: "spot", wander: null });
    // The pet has no such limit.
    expect(placeCharacter(noRules, new Set(["working", "day"]), null, 10, seeded(1), { tomo: false, reduced: false, at: "cushion" }).by).toBe("wander");
  });

  it("wander.when must hold too", () => {
    const byDay: Wanderer = { spot: "cushion", wander: { ...WANDER, when: "day" } };
    expect(wanders(byDay, IDLE, options)).toBe(true);
    expect(wanders(byDay, new Set(["idle", "night"]), options)).toBe(false);
    expect(placeCharacter(byDay, new Set(["idle", "night"]), { spot: "window", leaveAt: 0 }, 10, seeded(1), { ...options, at: "window" })).toEqual({ spot: "cushion", by: "spot", wander: null });
  });

  it("under reduced motion nobody wanders: it stands at its own spot, even mid-wander", () => {
    const reduced = { tomo: true, reduced: true };
    expect(wanders(CRAB, IDLE, reduced)).toBe(false);
    for (let seed = 0; seed < 20; seed++) {
      expect(placeCharacter(CRAB, IDLE, null, 0, seeded(seed), reduced)).toEqual({ spot: "cushion", by: "spot", wander: null });
      expect(placeCharacter(CRAB, IDLE, { spot: "window", leaveAt: 0 }, 1000, seeded(seed), { ...reduced, at: "window" })).toEqual({ spot: "cushion", by: "spot", wander: null });
    }
    // Rules still move it (that change means something).
    expect(placeCharacter(CRAB, WORKING, null, 0, seeded(1), reduced).spot).toBe("desk-chair");
  });

  it("without wander it is as before: a rule's spot, else its own", () => {
    const plain: Wanderer = { spot: "cushion", rules: CRAB.rules };
    expect(placeCharacter(plain, IDLE, null, 0, seeded(1), options)).toEqual({ spot: "cushion", by: "spot", wander: null });
    expect(placeCharacter(plain, WORKING, null, 0, seeded(1), options).spot).toBe("desk-chair");
  });
});
