import { describe, expect, it } from "vitest";
import { CONDITION, CONDITIONS, homeSceneSchema } from "../src/home/scene.js";
import { STARTER_SCENE } from "../src/home/starter.js";
import { checkHomeScene } from "../src/home/check.js";

describe("home scene format", () => {
  it("the starter room is a valid scene", () => {
    expect(homeSceneSchema.safeParse(STARTER_SCENE).success).toBe(true);
  });
  it("the starter room passes Tomo's own check with no problems and no warnings: it is the example Tomo learns from", () => {
    const result = checkHomeScene(STARTER_SCENE);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
  it("accepts every listed condition, its negation, and a pet mood; nothing else", () => {
    for (const condition of CONDITIONS) { expect(CONDITION.test(condition)).toBe(true); expect(CONDITION.test(`not:${condition}`)).toBe(true); }
    expect(CONDITION.test("pet:sleeping")).toBe(true);
    for (const bad of ["busy", "tool:rm", "not:not:idle", "working ", "pet:", "by:anyone"]) expect(CONDITION.test(bad)).toBe(false);
  });
  it("refuses anything that is not data in the format: unknown keys, reactions off the list, bad colours and asset names", () => {
    const base = structuredClone(STARTER_SCENE) as unknown as Record<string, unknown>;
    const bad = (change: (scene: any) => void) => { const scene = structuredClone(base); change(scene); return homeSceneSchema.safeParse(scene).success; };
    expect(bad((s) => { s.script = "alert(1)"; })).toBe(false);
    expect(bad((s) => { s.objects[0].onclick = "x"; })).toBe(false);
    expect(bad((s) => { s.objects[1].reactions[0].do = "explode"; })).toBe(false);
    expect(bad((s) => { s.objects[0].color = "red"; })).toBe(false);
    expect(bad((s) => { s.objects.push({ picture: "../memory/private/photo.png" }); })).toBe(false);
    expect(bad((s) => { s.objects.push({ picture: "art.png", size: [1, 1, 0.05] }); })).toBe(true);
    expect(bad((s) => { s.room.size = [200, 3, 6]; })).toBe(false);
    expect(bad((s) => { s.spots.nest = { at: [2, 0, 2] }; s.characters.pet = { kind: "visitor", spot: "cushion", rules: [{ when: "pet:sleeping", spot: "nest" }] }; })).toBe(true);
    expect(bad((s) => { s.objects.push({ kind: "tomo", scale: 1.5, at: [1, 0, 1] }); })).toBe(true);
    expect(bad((s) => { s.objects.push({ kind: "tomo", scale: 50 }); })).toBe(false);
    expect(bad((s) => { s.objects.push({ window: true, size: [1.8, 1.3, 0.05], at: [-1, 1.4, -2.98] }); })).toBe(true);
    expect(bad((s) => { s.objects.push({ window: "storm" }); })).toBe(false);
    expect(bad((s) => { s.objects[1].reactions[0].when = "weather:rain"; })).toBe(true);
    expect(bad((s) => { s.objects[1].reactions[0].when = "weather:meteors"; })).toBe(false);
    expect(bad((s) => { s.version = 2; })).toBe(false);
  });
});
