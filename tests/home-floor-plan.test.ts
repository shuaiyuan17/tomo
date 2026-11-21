import { describe, expect, it } from "vitest";
import { describeCondition, describeReaction, MAX_PLAN_CHARS, renderFloorPlan } from "../src/home/floor-plan.js";
import { CONDITIONS, REACTIONS, type HomeScene } from "../src/home/scene.js";
import { STARTER_SCENE } from "../src/home/starter.js";

/** A fixed room using every part of the format (not the starter: that one is being redesigned). */
const SCENE: HomeScene = {
  version: 1,
  name: "Test study",
  room: { size: [8, 3, 5], floor: "#7a5c3e", walls: "#e0d6c2", backdrop: "#101418" },
  light: { color: "#fff4e0", angle: 30, level: 0.7 },
  kinds: {
    chair: { parts: [{ shape: "box", size: [0.5, 0.45, 0.5], color: "#553311" }, { shape: "box", size: [0.5, 0.5, 0.05], at: [0, 0.45, -0.22] }] },
    me: { parts: [{ shape: "sphere", size: [0.6, 0.6, 0.6], color: "#5f7a4f" }] },
    guest: { parts: [{ shape: "cone", size: [0.4, 0.7, 0.4], color: "#c98a4b" }, { sign: "{task}", size: [1.6, 0.15, 0.02], at: [0, 0.8, 0] }] },
    cat: { parts: [{ shape: "sphere", size: [0.3, 0.25, 0.4], color: "#333333" }] },
  },
  objects: [
    { id: "desk", shape: "box", size: [1.6, 0.75, 0.8], at: [-2.5, 0, -1.9], color: "#8a6244" },
    { id: "lamp", shape: "cylinder", size: [0.15, 0.5, 0.15], at: [0.6, 0, 0], on: "desk", color: "#ddcc88",
      reactions: [{ when: ["working", "not:by:owner"], do: "glow", color: "#ffd27a" }, { when: "trouble", do: "pulse", amount: 0.2 }] },
    { kind: "chair", at: [-2.5, 0, -1.1], turn: [0, 180, 0] },
    { id: "big-chair", kind: "chair", at: [-0.5, 0, 1.6], scale: 1.5 },
    { id: "window", window: true, size: [1.8, 1.2, 0.06], at: [1, 1.1, -2.47], color: "#ffffff",
      reactions: [{ when: "weather:rain", do: "tint", color: "#8899aa" }] },
    { id: "board", sign: "Next job {next_job}", size: [1.6, 0.3, 0.02], at: [3.9, 1.6, 0], turn: [0, -90, 0], color: "#111111", background: "#f5f0e6" },
    { id: "poster", picture: "poster.png", size: [0.8, 1, 0.02], at: [-3.95, 1.2, 0.5], turn: [0, 90, 0] },
    { id: "shelf", parts: [{ shape: "box", size: [1.2, 0.04, 0.3] }, { shape: "box", size: [1.2, 0.04, 0.3], at: [0, 0.4, 0], reactions: [{ when: "night", do: "hide" }] }], at: [2.8, 0.5, -2.3] },
  ],
  spots: { "desk-chair": { at: [-2.5, 0, -1.1], facing: 180 }, rug: { at: [1, 0, 0.8], facing: 0 }, "seat-1": { at: [2, 0, 0.5], facing: 270 }, hall: { at: [3.5, 0, 2.2] } },
  characters: {
    tomo: { kind: "me", spot: "rug", rules: [{ when: "working", spot: "desk-chair" }, { when: "cron", spot: "seat-1" }] },
    visitors: { kind: "guest", kinds: { explore: "guest" }, spots: ["seat-1"], overflow: "hall" },
    pet: { kind: "cat", spot: "rug", rules: [{ when: "pet:sleeping", spot: "hall" }, { when: ["night", "not:pet:hungry"], spot: "desk-chair" }] },
  },
};

describe("home floor plan", () => {
  it("is stable for a fixed scene", () => {
    expect(renderFloorPlan(SCENE)).toMatchSnapshot();
  });
  it("is deterministic and bounded", () => {
    expect(renderFloorPlan(SCENE)).toBe(renderFloorPlan(structuredClone(SCENE)));
    const huge: HomeScene = { ...SCENE, objects: Array.from({ length: 400 }, (_, i) => ({ id: `box-${i}`, shape: "box" as const, size: [0.1, 0.1, 0.1] as [number, number, number], at: [0, 0, 0] as [number, number, number],
      reactions: [{ when: "working", do: "spin" as const, speed: 1 }, { when: "idle", do: "bob" as const, amount: 0.1 }] })) };
    const text = renderFloorPlan(huge);
    expect(text.length).toBeLessThanOrEqual(MAX_PLAN_CHARS);
    expect(text).toContain("cut short");
    expect(renderFloorPlan(STARTER_SCENE).length).toBeGreaterThan(100);
  });
  it("says every condition and reaction in words", () => {
    for (const condition of CONDITIONS) {
      expect(describeCondition(condition)).not.toBe(condition);
      expect(describeCondition(`not:${condition}`)).not.toBe(`not:${condition}`);
    }
    expect(describeCondition("pet:happy")).toBe("while the pet is happy");
    for (const reaction of REACTIONS) expect(describeReaction({ when: "working", do: reaction, color: "#ffffff" })).toContain("while working");
  });
  it("shows a scaled object's effective size", () => {
    expect(renderFloorPlan(SCENE)).toContain("big-chair: a chair, scaled ×1.5; front centre, base at (-0.5, 0, 1.6), top at 1.43 m, takes up 0.75 m wide × 0.75 m deep × 1.43 m high.");
  });
  it("says where the pet goes when, by its rules", () => {
    expect(renderFloorPlan(SCENE)).toContain("- The pet (a cat), when Tomo has one: at hall while the pet is sleeping; otherwise at desk-chair at night (outside the window) and while the pet is not hungry; otherwise at rug.");
  });
  it("lists windows as windows the app draws", () => {
    expect(renderFloorPlan(SCENE)).toContain("window 1.8×1.2 m (the app draws the sky in it)");
  });
  it("maps where each size of character can walk, says which spots are hopped to, and how far each trip is", () => {
    const scene: HomeScene = {
      version: 1,
      room: { size: [4, 3, 4], floor: "#a9825b", walls: "#d9cdb6" },
      kinds: { me: { parts: [{ shape: "sphere", size: [0.6, 0.6, 0.6] }] } },
      objects: [
        { id: "stool", shape: "box", size: [0.4, 0.45, 0.4], at: [1, 0, -1] },
        // A wall across the room with a 0.4 m gap: the pet's size gets through, Tomo's does not.
        { id: "wall-left", shape: "box", size: [1.8, 1, 0.2], at: [-1.1, 0, 1] },
        { id: "wall-right", shape: "box", size: [1.8, 1, 0.2], at: [1.1, 0, 1] },
      ],
      spots: { rug: { at: [0, 0, 0] }, seat: { at: [1, 0.45, -1] }, den: { at: [0, 0, 1.6] } },
      characters: { tomo: { kind: "me", spot: "rug", rules: [{ when: "working", spot: "seat" }, { when: "night", spot: "den" }] }, pet: { kind: "me", spot: "rug", rules: [{ when: "pet:sleeping", spot: "den" }] } },
    };
    const text = renderFloorPlan(scene);
    expect(text).toContain("Floor Tomo can walk on (Tomo's size): . floor one of its spots leads to, # in the way, ~ floor none of them gets to, digits are spots. Its spots are in 2 areas that cannot reach each other: rug and seat; den.");
    expect(text).toContain("Floor the pet can walk on (the pet's size): . floor one of its spots leads to");
    expect(text.split(/^Floor the pet/m)[1].split("\n\n")[0]).not.toContain("areas that cannot reach");
    expect(text).toContain("- 2 seat: at (1, 0.45, -1), back right, facing 0° (toward the viewer); a perch: a 0.");
    expect(text).toContain("- 3 den: at (0, 0, 1.6), front centre, facing 0° (toward the viewer); Tomo: on the floor, but cannot be walked to from rug or seat; the pet: on the floor.");
    expect(text).toMatch(/Walks from rug: to seat: [\d.]+ m on foot and a [\d.]+ m hop up; to den: it cannot walk \(it fades out and back in\)\./);
    // Tomo and the visitors are the same size: one map, whose areas say whose spots each holds.
    const apart = renderFloorPlan({ ...scene, spots: { ...scene.spots, hall: { at: [0, 0, 1.6] }, seat2: { at: [-1, 0, 1.6] } },
      characters: { tomo: { kind: "me", spot: "rug", rules: [{ when: "working", spot: "seat" }] }, visitors: { kind: "me", spots: ["seat2"], overflow: "hall" } } });
    expect(apart).toContain("Floor Tomo and the visitors can walk on (Tomo's size): . floor one of their spots leads to, # in the way, ~ floor none of them gets to, digits are spots. Their spots are in 2 areas that cannot reach each other: rug and seat; seat2 and the queue at hall.");
    expect(apart.match(/^Floor .* can walk on/gm)).toHaveLength(1);
    expect(text.match(/^Floor .* can walk on/gm)).toHaveLength(2);
    // No characters, no walking map.
    expect(renderFloorPlan({ ...scene, characters: undefined })).not.toContain("can walk on");
  });
});
