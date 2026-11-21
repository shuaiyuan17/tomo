import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeScene } from "../src/home/scene.js";
import { seeded } from "../web/src/home/wander.js";

/**
 * The stage's part of wandering, without a GPU: three.js's renderer and the
 * orbit controls are stand-ins, the browser's clock and timers are faked.
 * What is checked is where the stage sends each character (its target and
 * the move it planned), not what is drawn.
 */

vi.mock("three", async (actual) => {
  const three = await actual<typeof import("three")>();
  class WebGLRenderer {
    shadowMap = { enabled: false, type: 0 };
    domElement = {};
    setPixelRatio() {} setSize() {} render() {} dispose() {} forceContextLoss() {}
  }
  return { ...three, WebGLRenderer };
});
vi.mock("three/examples/jsm/controls/OrbitControls.js", async () => {
  const { Vector3 } = await import("three");
  class OrbitControls {
    target = new Vector3(); cursor = new Vector3(); enableDamping = true; minPolarAngle = 0; maxPolarAngle = Math.PI;
    addEventListener() {} update() { return false; } dispose() {}
  }
  return { OrbitControls };
});

let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
  vi.stubGlobal("performance", { now: () => clock * 1000 });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("document", { fonts: undefined, createElement: () => ({ getContext: () => null, width: 0, height: 0 }) });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const SCENE: HomeScene = {
  version: 1,
  room: { size: [6, 3, 6], floor: "#a9825b", walls: "#d9cdb6" },
  kinds: { crab: { parts: [{ shape: "sphere", size: [0.5, 0.3, 0.4] }] } },
  objects: [{ id: "desk", shape: "box", size: [1.4, 0.75, 0.7], at: [-1.8, 0, -2.4] }],
  spots: {
    cushion: { at: [0, 0, 0.5] }, window: { at: [2, 0, -2] }, "pool-side": { at: [-2, 0, 1.5] }, "desk-chair": { at: [-1.8, 0, -1.6], facing: 180 },
  },
  characters: {
    tomo: { kind: "crab", spot: "cushion", rules: [{ when: "working", spot: "desk-chair" }], walk: { speed: 0.8 },
      wander: { spots: ["cushion", "window", "pool-side"], every: [30, 90] } },
  },
};
const SKY = { known: false, progress: 0.5, weather: "clear" } as never;
const state = (conditions: string[]) => ({ conditions: new Set(conditions), values: {}, subagents: [], hasPet: false, sky: SKY });

async function stage(reduced = false) {
  const { HomeStage } = await import("../web/src/home/three/stage.js");
  const made = new HomeStage({} as HTMLCanvasElement, (name) => name);
  made.random = seeded(7);
  made.reducedMotion = reduced;
  made.setScene(structuredClone(SCENE), "r1");
  made.setState(state(["idle", "day"]));
  const tomo = () => (made as unknown as { characters: Map<string, { spot?: string; by?: string; to: number[]; plan: { duration: number } | null; wander: { leaveAt: number } | null }> }).characters.get("tomo")!;
  /** Moves the fake clock on, firing what is due. */
  const wait = (seconds: number) => { clock += seconds; vi.advanceTimersByTime(seconds * 1000); };
  return { made, tomo, wait };
}

describe("the stage wanders", () => {
  it("while idle it strolls from spot to spot at its own pace, the next only after its stay", async () => {
    const { tomo, wait } = await stage();
    const visited = [tomo().spot];
    const durations: number[] = [];
    expect(tomo().by).toBe("wander");
    for (let i = 0; i < 6; i++) {
      const leave = tomo().wander!.leaveAt;
      const before = tomo().spot;
      wait(Math.max(0, leave - clock - 1));
      expect(tomo().spot).toBe(before);
      wait(1.1);
      expect(tomo().spot).not.toBe(before);
      // A stroll at 0.8 m/s with no limit (a rule's move takes 3.5 s at most).
      expect(tomo().plan).not.toBeNull();
      durations.push(tomo().plan!.duration);
      visited.push(tomo().spot);
    }
    expect(new Set(visited).size).toBe(3);
    // window ↔ pool-side is over 5 m: more than 3.5 s at 0.8 m/s.
    expect(Math.max(...durations)).toBeGreaterThan(5);
  });

  it("a rule interrupts the stroll at once; when it ends it stays once, then wanders on", async () => {
    const { made, tomo, wait } = await stage();
    wait(tomo().wander!.leaveAt - clock + 0.05);
    expect(tomo().plan).not.toBeNull();
    wait(0.5);
    // Mid-stroll, a turn starts.
    made.setState(state(["working", "by:owner", "day"]));
    expect(tomo()).toMatchObject({ spot: "desk-chair", by: "rule", wander: null, to: [-1.8, 0, -1.6] });
    expect(tomo().plan!.duration).toBeLessThanOrEqual(3.5);
    // No wander timer moves it while the rule holds.
    wait(600);
    expect(tomo().spot).toBe("desk-chair");
    // The turn ends: it stays at the desk once, then strolls off.
    made.setState(state(["idle", "day"]));
    expect(tomo()).toMatchObject({ spot: "desk-chair", by: "wander" });
    const stay = tomo().wander!.leaveAt - clock;
    expect(stay).toBeGreaterThanOrEqual(30); expect(stay).toBeLessThanOrEqual(90);
    wait(stay + 0.1);
    expect(["cushion", "window", "pool-side"]).toContain(tomo().spot);
  });

  it("under reduced motion it does not wander: it stands at its spot, and stops wandering when the setting comes on", async () => {
    const reduced = await stage(true);
    expect(reduced.tomo()).toMatchObject({ spot: "cushion", by: "spot", wander: null, plan: null });
    reduced.wait(3600);
    expect(reduced.tomo()).toMatchObject({ spot: "cushion", by: "spot", wander: null });

    const { made, tomo, wait } = await stage();
    wait(tomo().wander!.leaveAt - clock + 0.05);
    made.reducedMotion = true;
    expect(tomo()).toMatchObject({ spot: "cushion", by: "spot", wander: null, plan: null, to: [0, 0, 0.5] });
    wait(3600);
    expect(tomo().spot).toBe("cushion");
  });

  it("paused (the tab hidden), a due wander waits for the page to come back, and then takes one step", async () => {
    const { made, tomo, wait } = await stage();
    const before = tomo().spot;
    made.pause();
    wait(tomo().wander!.leaveAt - clock + 500);
    expect(tomo().spot).toBe(before);
    made.resume();
    expect(tomo().spot).not.toBe(before);
    expect(tomo().wander!.leaveAt - clock).toBeGreaterThanOrEqual(30);
  });
});
