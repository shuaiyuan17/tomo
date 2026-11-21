import { describe, expect, it } from "vitest";
import { checkHomeScene, checkHomeSceneText, MAX_LISTED } from "../src/home/check.js";
import { MAX_OBJECTS, MAX_SCENE_BYTES, type HomeScene } from "../src/home/scene.js";
import { STARTER_SCENE } from "../src/home/starter.js";

/** A small fixed room (not the starter, which is being redesigned elsewhere). */
function room(): HomeScene {
  return {
    version: 1,
    room: { size: [6, 3, 6], floor: "#a9825b", walls: "#d9cdb6" },
    kinds: { me: { parts: [{ shape: "sphere", size: [0.6, 0.6, 0.6] }] }, guest: { parts: [{ shape: "sphere", size: [0.5, 0.5, 0.5] }] } },
    objects: [
      { id: "desk", shape: "box", size: [1.5, 0.8, 0.8], at: [-1.5, 0, -2], color: "#8a6244" },
      { id: "screen", shape: "box", size: [0.7, 0.4, 0.05], on: "desk", reactions: [{ when: "working", do: "glow" }] },
    ],
    spots: { chair: { at: [-1.5, 0, -1] }, seat: { at: [1.5, 0, 0] } },
    characters: { tomo: { kind: "me", spot: "chair" }, visitors: { kind: "guest", spots: ["seat"] } },
  };
}
const check = (change: (s: any) => void, assets?: string[]) => {
  const s: any = structuredClone(room());
  change(s);
  return checkHomeScene(s, assets ? { assets: new Set(assets) } : {});
};
const one = (change: (s: any) => void, assets?: string[]) => {
  const result = check(change, assets);
  expect(result.ok).toBe(false);
  expect(result.scene).toBeUndefined();
  return result.problems.join("\n");
};

describe("home scene check", () => {
  it("a good room passes with no problems or warnings; the starter passes", () => {
    expect(checkHomeScene(room())).toMatchObject({ ok: true, problems: [], warnings: [] });
    expect(checkHomeScene(STARTER_SCENE).ok).toBe(true);
  });

  it("schema problems name the place, by id, and say how to fix it", () => {
    expect(one((s) => { s.objects[1].color = "red"; })).toContain('objects[1] "screen".color: "red" should be a colour written as # and six hex digits');
    expect(one((s) => { s.objects[0].colr = "#ffffff"; })).toContain('objects[0] "desk": "colr" is not part of the scene format (did you mean "color"?)');
    expect(one((s) => { s.objects[1].reactions[0].do = "explode"; })).toMatch(/reactions\[0\]\.do: "explode" is not a reaction; use one of show, hide/);
    expect(one((s) => { s.objects[1].reactions[0].when = "busy"; })).toMatch(/when: "busy" should be a condition/);
    expect(one((s) => { s.objects.push({ picture: "../memory/private/x.png" }); })).toMatch(/objects\[2\]\.picture: .* is not a picture name/);
    expect(one((s) => { delete s.room.floor; })).toContain("room.floor is missing; add it.");
    expect(one((s) => { s.objects[0].at = [0, 0]; })).toContain('objects[0] "desk".at must be exactly three numbers [x, y, z]; it has 2.');
    expect(one((s) => { s.room.size = [30, 3, 6]; })).toContain("room.size[0]: 30 is too large; the most is 20.");
    expect(one((s) => { s.kinds["Big Chair"] = { parts: [{ shape: "box" }] }; })).toContain('the name "Big Chair" should be lowercase');
    expect(one((s) => { s.objects.push({ window: "open" }); })).toContain("window can only be true");
  });

  it("refuses text that is not JSON without quoting it", () => {
    const result = checkHomeSceneText('{\n  "version": 1,\n  "secret words here" oops\n}');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/scene\.json is not valid JSON near line 3/);
    expect(result.problems[0]).not.toContain("secret");
    expect(checkHomeSceneText("").problems[0]).toContain("not valid JSON");
    expect(checkHomeSceneText("x".repeat(MAX_SCENE_BYTES + 1)).problems[0]).toMatch(/KiB; the most is 256 KiB/);
    expect(checkHomeSceneText(JSON.stringify(room()), {}, "draft.json").ok).toBe(true);
  });

  it("unknown kind, on and spot references", () => {
    expect(one((s) => { s.objects.push({ kind: "chiar" }); })).toContain('objects[2]: kind "chiar" is not defined; add it under kinds or use one of me, guest.');
    expect(one((s) => { s.objects[1].on = "dsk"; })).toContain('on "dsk" names no top-level object (did you mean "desk"?)');
    expect(one((s) => { s.characters.tomo.spot = "sofa"; })).toContain('characters.tomo.spot: spot "sofa" is not defined');
    expect(one((s) => { s.characters.tomo.rules = [{ when: "working", spot: "bed" }]; })).toContain("characters.tomo.rules[0].spot");
    expect(one((s) => { s.characters.visitors.kind = "ghost"; })).toContain('characters.visitors.kind: kind "ghost" is not defined');
    expect(one((s) => { s.characters.visitors.kinds = { explore: "scout" }; })).toContain("characters.visitors.kinds.explore");
    expect(one((s) => { s.characters.visitors.overflow = "hall"; })).toContain("characters.visitors.overflow");
    expect(one((s) => { s.characters.pet = { kind: "cat", spot: "seat" }; })).toContain('characters.pet.kind: kind "cat"');
    expect(one((s) => { s.characters.pet = { kind: "guest", spot: "seat", rules: [{ when: "pet:sleeping", spot: "nets" }] }; }))
      .toContain('characters.pet.rules[0].spot: spot "nets" is not defined');
    expect(check((s) => { s.characters.pet = { kind: "guest", spot: "seat", rules: [{ when: "pet:sleeping", spot: "chair" }] }; }).ok).toBe(true);
  });

  it("kinds that use themselves or each other in a circle", () => {
    expect(one((s) => { s.kinds.loop = { parts: [{ kind: "loop" }] }; s.objects.push({ kind: "loop" }); })).toContain("kinds.loop: it uses itself");
    const circle = one((s) => { s.kinds.a = { parts: [{ kind: "b" }] }; s.kinds.b = { parts: [{ parts: [{ kind: "a" }] }] }; s.objects.push({ kind: "a" }); });
    expect(circle).toMatch(/"a" uses "b" uses "a", a circle/);
  });

  it("duplicate top-level ids, on below top level, on itself, on in a circle", () => {
    expect(one((s) => { s.objects.push({ id: "desk", shape: "box", at: [1, 0, 1] }); })).toContain('objects[2] "desk": objects[0] already has this id');
    expect(one((s) => { s.objects[0].parts = [{ shape: "box", on: "screen" }]; })).toContain("on is only for top-level objects");
    expect(one((s) => { s.objects[0].on = "desk"; })).toContain("it sits on itself");
    expect(one((s) => { s.objects[0].on = "screen"; })).toMatch(/"desk" sits on "screen" sits on "desk" again/);
  });

  it("exactly one of shape, kind, picture, sign, window; never nothing", () => {
    expect(one((s) => { s.objects.push({ shape: "box", sign: "hi" }); })).toContain("it is a shape and a sign at once");
    expect(one((s) => { s.objects.push({ window: true, picture: "a.png" }); })).toContain("it is a picture and a window at once");
    expect(one((s) => { s.objects.push({ at: [0, 0, 0] }); })).toContain("it is nothing");
    expect(check((s) => { s.objects.push({ parts: [{ shape: "box", size: [0.2, 0.2, 0.2] }], at: [2, 0, 2] }); }).ok).toBe(true);
    expect(check((s) => { s.objects.push({ window: true, size: [1.5, 1, 0.05], at: [0, 1, -2.98] }); }).ok).toBe(true);
  });

  it("expanded count and depth against the limits, and too many kinds or spots", () => {
    const many = one((s) => { s.kinds.stack = { parts: Array.from({ length: 40 }, () => ({ shape: "box", size: [0.1, 0.1, 0.1] })) }; for (let i = 0; i < 11; i++) s.objects.push({ kind: "stack", at: [0, 0, 0] }); });
    expect(many).toMatch(new RegExp(`The scene has \\d+ parts once kinds are expanded; the most is ${MAX_OBJECTS}.*stack: 40 parts each`));
    expect(one((s) => { s.kinds.deep = { parts: [{ parts: [{ parts: [{ parts: [{ shape: "box" }] }] }] }] }; s.objects.push({ kind: "deep" }); })).toMatch(/nests 5 levels deep once kinds are expanded; the most is 4/);
    expect(one((s) => { for (let i = 0; i < 65; i++) s.kinds[`k${i}`] = { parts: [{ shape: "box" }] }; })).toContain("kinds has 67 entries; the most is 64");
    expect(one((s) => { for (let i = 0; i < 33; i++) s.spots[`s${i}`] = { at: [0, 0, 0] }; })).toContain("spots has 35 entries; the most is 32");
  });

  it("parts far outside the room, turned and on things included", () => {
    expect(one((s) => { s.objects[0].at = [9, 0, -2]; })).toMatch(/objects\[0\] "desk": a part of it is centred at \(9, 0.4, -2\), 6 m beyond the right wall; the room is 6 m wide/);
    expect(one((s) => { s.objects.push({ id: "pole", shape: "box", size: [0.1, 0.1, 0.1], at: [0, 6, 0] }); })).toContain("beyond the ceiling");
    expect(one((s) => { s.objects[0].parts = [{ shape: "box", at: [0, 0, 8], size: [0.2, 0.2, 0.2] }]; s.objects[0].turn = [0, 90, 0]; })).toContain("beyond the right wall");
    expect(one((s) => { s.spots.far = { at: [0, 0, 9] }; })).toContain("spots.far: it is at (0, 0, 9)");
    // Just through a wall is fine (a picture hanging flush, a shelf poking out).
    expect(check((s) => { s.objects[0].at = [-3.2, 0, -2]; }).ok).toBe(true);
  });

  it("pictures must be in home/assets (when the folder is known), usable, and named only there", () => {
    expect(one((s) => { s.objects.push({ picture: "cat.png", size: [1, 1, 0.02], at: [0, 1, -2.9] }); }, ["dog.png"]))
      .toContain('picture "cat.png" is not in home/assets/; put the image file there under exactly that name');
    expect(check((s) => { s.objects.push({ picture: "cat.png", size: [1, 1, 0.02], at: [0, 1, -2.9] }); }, ["cat.png"]).ok).toBe(true);
    const refused = checkHomeScene({ ...room(), objects: [...room().objects, { picture: "big.png", at: [0, 1, -2.9] }] },
      { assets: new Set(), refusedAssets: new Map([["big.png", "it is 900 KiB; a picture can be at most 512 KiB"]]) });
    expect(refused.problems.join()).toContain('picture "big.png" is in home/assets/ but cannot be used: it is 900 KiB');
  });

  it("signs: unknown values are problems; {task} off a visitor and tint without a colour", () => {
    expect(one((s) => { s.objects.push({ sign: "{weather}", size: [2, 0.3, 0.02], at: [0, 1, -2.9] }); })).toContain("the sign shows {weather}, which is not a value");
    expect(one((s) => { s.objects[1].reactions = [{ when: "trouble", do: "tint" }]; })).toContain("tint needs a color");
    const task = check((s) => { s.objects.push({ sign: "{task}", size: [2, 0.2, 0.02], at: [0, 1, -2.9] }); });
    expect(task.ok).toBe(true);
    expect(task.warnings.join()).toContain("{task} is only filled in on a visitor's own sign");
    const onVisitor = check((s) => { s.kinds.guest.parts.push({ sign: "{task}", size: [4, 0.2, 0.02], at: [0, 0.6, 0] }); });
    expect(onVisitor.warnings.join()).not.toContain("{task}");
  });

  it("warnings: two solid objects in one space, a sign too long, unused kinds, unknown pet moods, background without a sign, a spot listed twice", () => {
    const overlap = check((s) => { s.objects.push({ id: "bed", shape: "box", size: [1.5, 0.8, 0.8], at: [-1.4, 0, -2] }); });
    expect(overlap.ok).toBe(true);
    expect(overlap.warnings).toEqual(['objects[0] "desk" and objects[2] "bed" occupy the same space around (-1.45, 0.4, -2); move one of them, or put one on the other with on.']);
    // Sitting on it is touching, not overlapping.
    expect(check((s) => { s.objects[1].size = [1.5, 0.8, 0.8]; s.objects[1].at = [0, -0.1, 0]; }).warnings).toEqual([]);
    expect(check((s) => { s.objects.push({ sign: "A very long line of text for such a tiny panel", size: [0.4, 0.2, 0.02], at: [0, 1, -2.9] }); }).warnings.join())
      .toMatch(/needs about [\d.]+ m even at its smallest text, but the panel is 0.4 m wide, so it will be cut short/);
    expect(check((s) => { s.kinds.spare = { parts: [{ shape: "box" }] }; }).warnings.join()).toContain("kinds.spare is defined but nothing uses it");
    expect(check((s) => { s.objects[1].reactions = [{ when: "pet:grumpy", do: "glow" }]; }).warnings.join()).toContain("pet:grumpy can never hold");
    expect(check((s) => { s.characters.pet = { kind: "guest", spot: "seat", rules: [{ when: ["idle", "pet:dozing"], spot: "chair" }] }; }).warnings.join())
      .toContain("characters.pet.rules[0]: pet:dozing can never hold");
    expect(check((s) => { s.characters.tomo.rules = [{ when: "not:pet:napping", spot: "seat" }]; }).warnings.join()).toContain("characters.tomo.rules[0]: pet:napping");
    expect(check((s) => { s.objects[0].background = "#000000"; }).warnings.join()).toContain("background only colours a sign's panel");
    expect(check((s) => { s.characters.visitors.spots = ["seat", "seat"]; }).warnings.join()).toContain('"seat" is listed twice');
  });

  it("scale grows a part and everything in it: bounds, far outside and overlaps follow it", () => {
    // A kind instance near the wall, fine at scale 1 and far outside at 10.
    expect(check((s) => { s.objects.push({ kind: "guest", at: [0, 1.8, 0] }); }).ok).toBe(true);
    expect(one((s) => { s.objects.push({ kind: "guest", at: [0, 1.8, 0], scale: 10 }); })).toContain("beyond the ceiling");
    // Child positions scale too: a part 0.5 m out becomes 4 m out.
    expect(one((s) => { s.objects.push({ parts: [{ shape: "box", size: [0.1, 0.1, 0.1], at: [0.5, 0, 0] }], at: [2.5, 0, 0], scale: 8 }); })).toContain("beyond the right wall");
    // A small box beside the desk overlaps it once scaled up.
    const beside = (scale: number) => check((s) => { s.objects.push({ id: "crate", shape: "box", size: [0.4, 0.4, 0.4], at: [-0.4, 0, -2], scale }); }).warnings;
    expect(beside(1)).toEqual([]);
    expect(beside(4).join()).toContain('objects[0] "desk" and objects[2] "crate" occupy the same space');
    // What rests on a scaled object is placed on its scaled top, and is not scaled itself.
    const onScaled = checkHomeScene({ ...room(), objects: [{ id: "desk", shape: "box", size: [1.5, 0.8, 0.8], at: [-1.5, 0, -2], scale: 2 },
      { id: "screen", shape: "box", size: [0.7, 0.4, 0.05], on: "desk", at: [0, 0, 0] }] });
    expect(onScaled.ok).toBe(true);
    // (The scaled desk now covers the chair spot: only the reachability warning, no overlap.)
    expect(onScaled.warnings.filter((w) => !w.startsWith("characters."))).toEqual([]);
  });

  it("warns that size means nothing on a group or kind instance, and about amounts above a reaction's cap", () => {
    expect(check((s) => { s.objects.push({ kind: "guest", size: [2, 2, 2], at: [2, 0, 2] }); }).warnings.join()).toContain('size means nothing on a kind instance; to make it bigger or smaller use "scale"');
    expect(check((s) => { s.objects.push({ parts: [{ shape: "box", size: [0.2, 0.2, 0.2] }], size: [2, 2, 2], at: [2, 0, 2] }); }).warnings.join()).toContain("size means nothing on a group");
    expect(check((s) => { s.objects[0].size = [1.5, 0.8, 0.8]; }).warnings).toEqual([]);
    expect(check((s) => { s.objects[1].reactions = [{ when: "working", do: "pulse", amount: 0.9 }]; }).warnings.join()).toContain("pulse amount 0.9 is above its cap of 0.5 and will be drawn as 0.5");
    expect(check((s) => { s.objects[1].reactions = [{ when: "working", do: "bob", amount: 2 }]; }).warnings.join()).toContain("bob amount 2 is above its cap of 1");
    expect(check((s) => { s.objects[1].reactions = [{ when: "working", do: "swing", amount: 45 }, { when: "idle", do: "glow", amount: 30 }]; }).warnings).toEqual([]);
  });

  it("lists at most MAX_LISTED problems and counts the rest", () => {
    const result = check((s) => { for (let i = 0; i < 60; i++) s.objects.push({ kind: `nope-${i}` }); });
    expect(result.problems).toHaveLength(MAX_LISTED + 1);
    expect(result.problems.at(-1)).toMatch(/^…and \d+ more like these\.$/);
  });

  describe("reachability", () => {
    /** room() split by a wall across z = 1 with a 0.4 m gap in the middle: wide enough for the pet, not for Tomo or a visitor. */
    const walled = (change: (s: any) => void = () => {}) => check((s) => {
      s.objects.push({ id: "wall-left", shape: "box", size: [2.8, 1, 0.2], at: [-1.6, 0, 1] }, { id: "wall-right", shape: "box", size: [2.8, 1, 0.2], at: [1.6, 0, 1] });
      s.spots.den = { at: [0, 0, 2.2] };
      s.kinds.cat = { parts: [{ shape: "sphere", size: [0.2, 0.2, 0.2] }] };
      change(s);
    });
    const reachWarnings = (result: { warnings: string[] }) => result.warnings.filter((w) => w.startsWith("characters."));

    it("warns, without failing the scene, when a rule's spot cannot be walked to, and says how far and what is in the way", () => {
      const result = walled((s) => { s.characters.tomo.rules = [{ when: "working", spot: "den" }]; });
      expect(result.ok).toBe(true);
      expect(reachWarnings(result)).toEqual([
        'characters.tomo.rules[0]: Tomo cannot walk from "chair" to "den": the spot is on the floor, cut off from where it can walk; the nearest floor it can reach is 1.65 m from the spot, and the nearest thing in the way is objects[2] "wall-left". It fades out and back in there instead (it still gets there). Move the spot, or open a gap at least 0.6 m wide next to it.',
      ]);
    });

    it("no warning when the spot can be walked to", () => {
      expect(reachWarnings(check((s) => { s.characters.tomo.rules = [{ when: "working", spot: "seat" }]; }))).toEqual([]);
      // The same wall with the gap opened to 0.8 m.
      expect(reachWarnings(walled((s) => { s.objects[3].at = [-1.8, 0, 1]; s.objects[2].at = [1.8, 0, 1]; s.characters.tomo.rules = [{ when: "working", spot: "den" }]; }))).toEqual([]);
    });

    it("checks each character at its own size: the pet fits through the gap, a visitor (from its overflow spot) does not", () => {
      const result = walled((s) => {
        s.characters.pet = { kind: "cat", spot: "chair", rules: [{ when: "pet:sleeping", spot: "den" }] };
        s.characters.visitors.overflow = "den";
      });
      expect(reachWarnings(result)).toHaveLength(1);
      expect(reachWarnings(result)[0]).toMatch(/^characters\.visitors\.spots\[0\]: a visitor cannot walk from "den" to "seat"/);
    });

    it("names a part shown only some of the time that blocks a hop, and says it counts even while not drawn", () => {
      const result = check((s) => {
        s.objects.push({ id: "stool", shape: "box", size: [0.4, 0.45, 0.4], at: [1.5, 0, -1] },
          { id: "canopy", shape: "box", size: [1.6, 0.1, 1.6], at: [1.5, 1, -1], reactions: [{ when: "night", do: "show" }] });
        s.spots.perch = { at: [1.5, 0.45, -1] };
        s.characters.tomo.rules = [{ when: "working", spot: "perch" }];
      });
      expect(reachWarnings(result)).toHaveLength(1);
      expect(reachWarnings(result)[0]).toContain('characters.tomo.rules[0]: Tomo cannot walk from "chair" to "perch": the nearest floor it can reach is');
      expect(reachWarnings(result)[0]).toContain('is blocked by objects[3] "canopy", including a part shown only at night (outside the window).');
      expect(reachWarnings(result)[0]).toContain("A part that is shown or hidden by a reaction is in the way even while it is not drawn.");
    });
  });
});
