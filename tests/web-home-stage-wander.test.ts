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

  it("paused, status updates and the clock do not move the wander on; back on the page it takes one step", async () => {
    const { made, tomo, wait } = await stage();
    const before = { spot: tomo().spot, wander: { ...tomo().wander! } };
    made.pause();
    wait(tomo().wander!.leaveAt - clock + 500);
    // A status update arrives while the tab is hidden.
    made.setState(state(["idle", "day"]));
    expect(tomo().spot).toBe(before.spot);
    expect(tomo().wander).toEqual(before.wander);
    made.setState(state(["idle", "day"]));
    expect(tomo().wander).toEqual(before.wander);
    made.resume();
    expect(tomo().spot).not.toBe(before.spot);
    expect(tomo().wander!.leaveAt - clock).toBeGreaterThanOrEqual(30);
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

describe("the stage keeps characters apart", () => {
  it("on first load Tomo's random pick avoids where the pet's rules put it (placed after Tomo)", async () => {
    const { HomeStage } = await import("../web/src/home/three/stage.js");
    const scene = structuredClone(SCENE);
    scene.kinds!.cat = { parts: [{ shape: "sphere", size: [0.2, 0.2, 0.2] }] };
    // The pet stands at "window" (its own spot) and goes to "pool-side" to sleep: both are wander spots of Tomo's.
    scene.characters!.pet = { kind: "cat", spot: "window", rules: [{ when: "pet:sleeping", spot: "pool-side" }] };
    for (const [conditions, taken] of [[["idle", "day"], "window"], [["idle", "day", "pet:sleeping"], "pool-side"]] as const) {
      for (let seed = 0; seed < 40; seed++) {
        const made = new HomeStage({} as HTMLCanvasElement, (name) => name);
        made.random = seeded(seed);
        made.setScene(scene, "r1");
        made.setState({ ...state([...conditions]), hasPet: true });
        const cast = (made as unknown as { characters: Map<string, { spot?: string }> }).characters;
        expect(cast.get("pet")!.spot).toBe(taken);
        expect(cast.get("tomo")!.spot).not.toBe(taken);
        made.dispose();
      }
    }
  });
});

describe("the stage's others", () => {
  type Cast = Map<string, { spot?: string; by?: string; to: number[]; plan: { duration: number } | null; wander: { leaveAt: number } | null; leaving: boolean;
    walking: boolean; body: { parts: Array<{ target: { visible: boolean } }> } | null }>;
  const crowd = (): HomeScene => {
    const scene = structuredClone(SCENE);
    scene.kinds!.dog = { parts: [{ shape: "sphere", size: [0.5, 0.35, 0.9] }] };
    scene.kinds!.cat = { parts: [{ shape: "sphere", size: [0.2, 0.2, 0.2] }] };
    scene.spots!.rug = { at: [1, 0, 1.5] };
    const spots = ["cushion", "window", "pool-side", "rug"];
    scene.characters!.pet = { kind: "cat", spot: "pool-side", wander: { spots, every: [5, 10] } };
    scene.characters!.tomo!.wander = { spots, every: [5, 10] };
    scene.characters!.others = {
      momo: { kind: "dog", spot: "window", walk: { speed: 1.1, radius: 0.35 }, wander: { spots, every: [5, 10] } },
      rex: { kind: "dog", spot: "rug", wander: { spots, every: [5, 10] } },
    };
    return scene;
  };
  const make = async (scene: HomeScene, seed: number, conditions = ["idle", "day"], hasPet = true, reduced = false) => {
    const { HomeStage } = await import("../web/src/home/three/stage.js");
    const made = new HomeStage({} as HTMLCanvasElement, (name) => name);
    made.random = seeded(seed);
    made.reducedMotion = reduced;
    made.setScene(scene, "r1");
    made.setState({ ...state(conditions), hasPet });
    return { made, cast: (made as unknown as { characters: Cast }).characters };
  };
  /** Where every character still on the stage is at or heading to: no two the same. */
  const apart = (cast: Cast) => {
    const targets = [...cast.values()].filter((c) => !c.leaving).map((c) => c.to.join(","));
    expect(new Set(targets).size).toBe(targets.length);
  };

  it("are drawn whether or not there is a pet, keyed by name, and wander like the pet", async () => {
    const { cast } = await make(crowd(), 3, ["idle", "day"], false);
    expect([...cast.keys()].sort()).toEqual(["others.momo", "others.rex", "tomo"]);
    expect(cast.get("others.momo")!.by).toBe("wander");
    // While Tomo works, the others still wander (Tomo goes to its rule's spot).
    const working = await make(crowd(), 3, ["working", "by:owner", "day"]);
    expect(working.cast.get("tomo")!.by).toBe("rule");
    expect(working.cast.get("others.rex")!.by).toBe("wander");
  });

  it("four characters wandering over four spots never stand at, or head for, the same one: from the first placement, and on every step", async () => {
    for (let seed = 0; seed < 25; seed++) {
      const { made, cast } = await make(crowd(), seed);
      expect(cast.size).toBe(4);
      apart(cast);
      let moved = 0;
      for (let step = 0; step < 12; step++) {
        const before = [...cast.values()].map((c) => c.spot).join();
        const next = Math.min(...[...cast.values()].map((c) => c.wander?.leaveAt ?? Infinity));
        clock = Math.max(clock, next) + 0.05; vi.advanceTimersByTime(Math.max(0, (next - clock) * 1000) + 100);
        made.setState({ ...state(["idle", "day"]), hasPet: true });
        apart(cast);
        if ([...cast.values()].map((c) => c.spot).join() !== before) moved++;
      }
      // Four characters on four spots can never move (each spot is taken); they stay put, apart.
      expect(moved).toBe(0);
      made.dispose();
    }
  });

  it("with a spot to spare they take turns moving, and still never share one; a rule's spot is kept free of random picks", async () => {
    for (let seed = 0; seed < 25; seed++) {
      const scene = crowd();
      scene.spots!.corner = { at: [2.2, 0, 2.2] };
      scene.spots!.door = { at: [-2.2, 0, 2.4] };
      for (const who of [scene.characters!.tomo!, scene.characters!.pet!, ...Object.values(scene.characters!.others!)]) who.wander!.spots.push("corner", "door");
      // rex goes to the window at night (a rule): nobody else may be put there.
      scene.characters!.others!.rex.rules = [{ when: "night", spot: "window" }];
      const { made, cast } = await make(scene, seed, ["idle", "night"]);
      expect(cast.get("others.rex")).toMatchObject({ spot: "window", by: "rule" });
      apart(cast);
      let moved = 0;
      for (let step = 0; step < 10; step++) {
        const before = [...cast.values()].map((c) => c.spot).join();
        const next = Math.min(...[...cast.values()].map((c) => c.wander?.leaveAt ?? Infinity));
        clock = Math.max(clock, next) + 0.05; vi.advanceTimersByTime(100);
        made.setState({ ...state(["idle", "night"]), hasPet: true });
        apart(cast);
        for (const [key, c] of cast) if (key !== "others.rex") expect(c.spot).not.toBe("window");
        if ([...cast.values()].map((c) => c.spot).join() !== before) moved++;
      }
      expect(moved).toBeGreaterThan(0);
      made.dispose();
    }
  });

  it("under reduced motion the others stand at their spots too", async () => {
    const { cast } = await make(crowd(), 1, ["idle", "day"], true, true);
    expect(cast.get("others.momo")).toMatchObject({ spot: "window", by: "spot", wander: null, plan: null });
    expect(cast.get("others.rex")).toMatchObject({ spot: "rug", by: "spot", wander: null, plan: null });
  });
});

describe("the walking condition", () => {
  it("holds on a character's body while it walks, and stops holding when it arrives", async () => {
    const scene = structuredClone(SCENE);
    // Eyes open while walking, closed (the lid shown) while standing.
    scene.kinds!.crab = { parts: [{ shape: "sphere", size: [0.5, 0.3, 0.4] },
      { shape: "box", size: [0.2, 0.04, 0.02], at: [0, 0.3, 0.2], reactions: [{ when: ["idle", "not:walking"], do: "show" }] },
      { shape: "box", size: [0.1, 0.1, 0.1], at: [0, 0.3, 0.2], reactions: [{ when: "walking", do: "show" }] }] };
    const { HomeStage } = await import("../web/src/home/three/stage.js");
    const made = new HomeStage({} as HTMLCanvasElement, (name) => name);
    made.random = seeded(7);
    made.setScene(scene, "r1");
    made.setState(state(["idle", "day"]));
    type Body = { walking: boolean; plan: { duration: number } | null; start: number; body: { parts: Array<{ node: { reactions?: unknown[] }; target: { visible: boolean } }> } };
    const tomo = () => (made as unknown as { characters: Map<string, Body> }).characters.get("tomo")!;
    const step = () => (made as unknown as { stepCharacter: (c: Body, now: number, dt: number) => boolean }).stepCharacter(tomo(), clock, 1 / 60);
    const [lid, open] = tomo().body.parts.filter((p) => p.node.reactions?.length);
    const look = () => ({ walking: tomo().walking, lid: lid.target.visible, open: open.target.visible });
    // Placed on the page: standing.
    expect(look()).toEqual({ walking: false, lid: true, open: false });
    // Its stay is over: it strolls off.
    clock = (made as unknown as { characters: Map<string, { wander: { leaveAt: number } }> }).characters.get("tomo")!.wander.leaveAt + 0.05;
    vi.advanceTimersByTime(100_000);
    expect(tomo().plan).not.toBeNull();
    expect(look()).toEqual({ walking: true, lid: false, open: true });
    // A status update mid-walk keeps it walking.
    made.setState(state(["idle", "day"]));
    expect(look()).toEqual({ walking: true, lid: false, open: true });
    // Arrived: standing again.
    clock = tomo().start + tomo().plan!.duration + 0.01;
    step();
    expect(tomo().plan).toBeNull();
    expect(look()).toEqual({ walking: false, lid: true, open: false });
    made.dispose();
  });

  it("never holds on the room's own parts, and not under reduced motion (nothing walks)", async () => {
    const scene = structuredClone(SCENE);
    scene.objects.push({ id: "sign", shape: "box", size: [0.2, 0.2, 0.2], at: [2, 0, 2], reactions: [{ when: "walking", do: "show" }] });
    scene.kinds!.crab.parts.push({ shape: "box", size: [0.1, 0.1, 0.1], reactions: [{ when: "walking", do: "show" }] });
    const { HomeStage } = await import("../web/src/home/three/stage.js");
    const made = new HomeStage({} as HTMLCanvasElement, (name) => name);
    made.random = seeded(7);
    made.setScene(scene, "r1");
    made.setState(state(["idle", "day"]));
    const internals = made as unknown as { built: { parts: Array<{ node: { reactions?: unknown[] }; target: { visible: boolean } }> }; characters: Map<string, { plan: unknown; wander: { leaveAt: number }; body: { parts: Array<{ node: { reactions?: unknown[] }; target: { visible: boolean } }> } }> };
    clock = internals.characters.get("tomo")!.wander.leaveAt + 0.05;
    vi.advanceTimersByTime(100_000);
    expect(internals.characters.get("tomo")!.plan).not.toBeNull();
    expect(internals.built.parts.find((p) => p.node.reactions?.length)!.target.visible).toBe(false);
    expect(internals.characters.get("tomo")!.body.parts.find((p) => p.node.reactions?.length)!.target.visible).toBe(true);
    made.reducedMotion = true;
    expect(internals.characters.get("tomo")!.plan).toBeNull();
    expect(internals.characters.get("tomo")!.body.parts.find((p) => p.node.reactions?.length)!.target.visible).toBe(false);
    made.dispose();
  });
});
