import { describe, expect, it } from "vitest";
import { Box3, Group, Mesh, BoxGeometry } from "three";
import { MAX_SIGN_CHARS, REACTION_DEFAULTS, REACTIONS, SHAPES, SIGN_VALUES, WEATHERS, homeSceneSchema, type HomePart, type HomeScene } from "../src/home/scene.js";
import { HOME_SNAPSHOT_MAX_BYTES } from "../src/web/protocol.js";
import { STARTER_SCENE } from "../src/home/starter.js";
import type { HomeStatus } from "../src/home/status.js";
import * as contract from "../web/src/home/contract.js";
import { cronFlashing, formatHomeSpan, homeCaption, localizeHomeStatus, newerStatus } from "../web/src/home/caption.js";
import { fillSign, holds, homeConditions, partEffects, seatVisitors, signValues, characterSpot, visitorKind, waitingPosition } from "../web/src/home/evaluate.js";
import { layoutKind, layoutScene, rotationRows, transformBox, type LayoutNode } from "../web/src/home/layout.js";
import { localSky, skyLight, skyOf, weatherWords } from "../web/src/home/sky.js";
import { base64Bytes, snapshotBody } from "../web/src/home/snapshot.js";
import { homeReadDue, isHomeHash } from "../web/src/home/home-page.js";

const NOW = new Date(2026, 10, 15, 14, 0, 0).getTime(); // 14:00 local
const idle = (over: Partial<HomeStatus> = {}): HomeStatus => ({ working: false, subagents: [], tasks: 0, compacting: false, at: NOW, ...over });

describe("home contract copies", () => {
  it("match the originals the browser avoids importing (they pull in zod)", () => {
    expect(contract.SIGN_VALUES).toEqual(SIGN_VALUES);
    expect(contract.MAX_SIGN_CHARS).toBe(MAX_SIGN_CHARS);
    expect(contract.HOME_SNAPSHOT_MAX_BYTES).toBe(HOME_SNAPSHOT_MAX_BYTES);
    expect(contract.REACTION_DEFAULTS).toEqual(REACTION_DEFAULTS);
  });
});

describe("home caption", () => {
  it("says what is happening, work first", () => {
    expect(homeCaption(idle({ working: true, by: "owner", subagents: [{ id: "a" }, { id: "b" }] }), NOW)).toBe("Working on your message · 2 subagents");
    expect(homeCaption(idle({ working: true, by: "cron" }), NOW)).toBe("Running a scheduled job");
    expect(homeCaption(idle({ working: true, by: "owner", tool: "shell" }), NOW)).toBe("Working on your message · running a command");
    expect(homeCaption(idle({ working: true, by: "owner", tool: "web", trouble: "retry" }), NOW)).toBe("Working on your message · retrying");
    expect(homeCaption(idle({ working: true, by: "group", trouble: "rate_limit" }), NOW)).toBe("Answering a group chat · rate-limited, waiting");
    expect(homeCaption(idle({ working: true, compacting: true }), NOW)).toBe("Compacting context");
    expect(homeCaption(idle({ trouble: "error" }), NOW)).toBe("The last turn hit an error");
    expect(homeCaption(idle({ idleSince: NOW - 20 * 60_000 }), NOW)).toBe("Idle for 20 min");
    expect(homeCaption(idle({ idleSince: NOW - 20 * 60_000, tasks: 1 }), NOW)).toBe("Idle for 20 min · 1 background task");
    expect(homeCaption(idle({ idleSince: NOW - 60_000, nextJobAt: NOW + 12 * 60_000 }), NOW)).toBe("Idle for 1 min · next job in 12 min");
    expect(homeCaption(idle({ cronAt: NOW - 2_000 }), NOW)).toBe("A scheduled job just fired");
    expect(homeCaption(idle(), NOW)).toBe("Idle");
  });
  it("mentions the weather last, only when the daemon reported it", () => {
    expect(homeCaption(idle({ working: true, by: "owner", sky: { weather: "rain", phase: "day", progress: 0.5, tempC: 11.4 } }), NOW)).toBe("Working on your message · 11°C, raining");
    expect(homeCaption(idle({ sky: { weather: "fog", phase: "night", progress: 0.5 } }), NOW)).toBe("Idle · foggy");
  });
  it("spans and the cron flash", () => {
    expect(formatHomeSpan(30_000)).toBe("under a minute");
    expect(formatHomeSpan(90 * 60_000)).toBe("1 h 30 min");
    expect(formatHomeSpan(5 * 3600_000 + 60_000)).toBe("5 h");
    expect(formatHomeSpan(50 * 3600_000)).toBe("2 days");
    expect(cronFlashing(idle({ cronAt: NOW - 5_900 }), NOW)).toBe(true);
    expect(cronFlashing(idle({ cronAt: NOW - 6_000 }), NOW)).toBe(false);
  });
  it("moves the daemon's times onto the browser's clock, and keeps the newer status", () => {
    // The daemon's clock is 10 minutes ahead of the browser's.
    const daemon = NOW + 600_000;
    const local = localizeHomeStatus(idle({ at: daemon, idleSince: daemon - 300_000, cronAt: daemon - 1_000, nextJobAt: daemon + 60_000 }), NOW);
    expect(local.status).toMatchObject({ at: NOW, idleSince: NOW - 300_000, cronAt: NOW - 1_000, nextJobAt: NOW + 60_000 });
    expect(local.daemonAt).toBe(daemon);
    const older = localizeHomeStatus(idle({ at: daemon - 5_000, working: true }), NOW + 10);
    expect(newerStatus(local, older)).toBe(local);
    expect(newerStatus(older, local)).toBe(local);
    expect(newerStatus(undefined, older)).toBe(older);
  });
});

describe("home conditions", () => {
  it("holds what the status says, and day / night from the viewer's clock without a sky", () => {
    const set = homeConditions(idle({ working: true, by: "owner", tool: "web", subagents: [{ id: "a" }], tasks: 2, compacting: true, trouble: "retry", cronAt: NOW, pet: "Sleeping" }), NOW);
    expect([...set].sort()).toEqual(["by:owner", "compacting", "cron", "day", "pet:sleeping", "subagents", "tasks", "tool:web", "trouble", "working"]);
    expect(homeConditions(idle(), new Date(2026, 10, 15, 23, 0).getTime()).has("night")).toBe(true);
    expect(homeConditions(idle({ working: true, by: "other" }), NOW).has("by:other")).toBe(false);
    expect([...homeConditions(idle(), NOW)].some((c) => c.startsWith("weather:"))).toBe(false);
  });
  it("takes day / night and the weather from the sky outside when reported (dawn and dusk are day)", () => {
    const night = homeConditions(idle({ sky: { weather: "snow", phase: "night", progress: 0.2 } }), NOW);
    expect(night.has("night") && night.has("weather:snow") && !night.has("day")).toBe(true);
    expect(homeConditions(idle({ sky: { weather: "clear", phase: "dusk", progress: 0.98 } }), new Date(2026, 10, 15, 23, 0).getTime()).has("day")).toBe(true);
    for (const weather of WEATHERS) expect(homeConditions(idle({ sky: { weather, phase: "day", progress: 0.5 } }), NOW).has(`weather:${weather}`)).toBe(true);
  });
  it("negations and lists", () => {
    const set = new Set(["working", "night"]);
    expect(holds("working", set)).toBe(true);
    expect(holds("not:working", set)).toBe(false);
    expect(holds("not:idle", set)).toBe(true);
    expect(holds(["working", "night"], set)).toBe(true);
    expect(holds(["working", "not:night"], set)).toBe(false);
    expect(holds("not:pet:sleeping", set)).toBe(true);
  });
});

describe("part reactions", () => {
  it("show / hide, and the first of each other kind that holds", () => {
    const set = new Set(["working", "trouble"]);
    expect(partEffects([{ when: "idle", do: "show" }], set).visible).toBe(false);
    expect(partEffects([{ when: "idle", do: "show" }, { when: "working", do: "show" }], set).visible).toBe(true);
    expect(partEffects([{ when: "working", do: "show" }, { when: "trouble", do: "hide" }], set).visible).toBe(false);
    const effects = partEffects([{ when: "trouble", do: "glow", color: "#ff0000" }, { when: "working", do: "glow", color: "#00ff00" }, { when: "working", do: "tint", color: "#0000ff" }, { when: "working", do: "glow" }], set);
    expect(effects).toMatchObject({ glow: "#ff0000", tint: "#0000ff", bob: null });
    expect(partEffects([{ when: "working", do: "glow" }], set).glow).toBe("self");
  });
  it("defaults amounts and speeds, and keeps them sane", () => {
    const set = new Set(["working"]);
    expect(partEffects([{ when: "working", do: "bob" }], set).bob).toEqual({ amount: 0.06, speed: 1.2 });
    expect(partEffects([{ when: "working", do: "spin", speed: 2 }], set).spin).toEqual({ amount: 0, speed: 2 });
    expect(partEffects([{ when: "working", do: "pulse", amount: 40 }], set).pulse!.amount).toBe(0.5);
    expect(partEffects([{ when: "working", do: "swing", amount: 30, speed: 0.5 }], set).swing).toEqual({ amount: 30, speed: 0.5 });
    expect(partEffects(undefined, set).visible).toBe(true);
  });
});

describe("signs", () => {
  it("fills live values, leaves unknown braces, and stays short", () => {
    const values = signValues(idle({ idleSince: NOW - 20 * 60_000, nextJobAt: NOW + 12 * 60_000, tasks: 3, subagents: [{ id: "a" }] }), NOW);
    expect(fillSign("Idle {idle} · next {next_job}", values)).toBe("Idle 20 min · next in 12 min");
    expect(fillSign("{subagents} visitors, {tasks} tasks, {nope}", values)).toBe("1 visitors, 3 tasks, {nope}");
    expect(fillSign("{status}", values)).toBe("Idle for 20 min · 1 subagent · 3 background tasks");
    expect(fillSign("{tool}", values)).toBe("");
    const long = fillSign("Task: {task}", { ...values, task: "x".repeat(200) });
    expect(long.length).toBe(MAX_SIGN_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(fillSign("{task}", { ...values, task: "line\nbreak  here" })).toBe("line break here");
  });
});

describe("characters", () => {
  it("Tomo and the pet go where their first holding rule says, else their own spot", () => {
    const tomo = { kind: "tomo", spot: "cushion", rules: [{ when: "by:heartbeat", spot: "window" }, { when: "working", spot: "desk" }] };
    expect(characterSpot(tomo, new Set(["working", "by:heartbeat"]))).toBe("window");
    expect(characterSpot(tomo, new Set(["working"]))).toBe("desk");
    expect(characterSpot(tomo, new Set(["idle"]))).toBe("cushion");
    const pet = STARTER_SCENE.characters!.pet!;
    expect(characterSpot(pet, homeConditions(idle({ pet: "sleeping" }), NOW))).toBe("pet-nest");
    expect(characterSpot(pet, homeConditions(idle({ pet: "happy" }), NOW))).toBe("pet-bed");
    expect(characterSpot({ spot: "bed" }, new Set())).toBe("bed");
  });
  it("seats visitors in order, keeps each one's seat, and the waiting take freed seats", () => {
    const first = seatVisitors([{ id: "a" }, { id: "b" }, { id: "c" }], 2, new Map());
    expect([...first.seated]).toEqual([["a", 0], ["b", 1]]);
    expect(first.waiting).toEqual(["c"]);
    // a finishes: b keeps seat 1, c moves into seat 0.
    const second = seatVisitors([{ id: "b" }, { id: "c" }, { id: "d" }], 2, first.seated);
    expect(second.seated.get("b")).toBe(1);
    expect(second.seated.get("c")).toBe(0);
    expect(second.waiting).toEqual(["d"]);
    // A seat that no longer exists is given up.
    expect(seatVisitors([{ id: "b" }], 1, second.seated).seated.get("b")).toBe(0);
  });
  it("gives a subagent type its own body", () => {
    const visitors = { kind: "visitor", kinds: { explore: "scout" }, spots: ["s"] };
    expect(visitorKind(visitors, "Explore")).toBe("scout");
    expect(visitorKind(visitors, "plan")).toBe("visitor");
    expect(visitorKind(visitors, undefined)).toBe("visitor");
  });
  it("lines the waiting up across the way they face, inside the room", () => {
    const spot = { at: [0, 0, 2] as [number, number, number], facing: 0 };
    expect(waitingPosition(spot, 0, [6, 3, 6])).toEqual([0, 0, 2]);
    expect(waitingPosition(spot, 1, [6, 3, 6])[0]).toBeCloseTo(0.7);
    expect(waitingPosition(spot, 2, [6, 3, 6])[0]).toBeCloseTo(-0.7);
    expect(waitingPosition({ at: [2.5, 0, 0], facing: 0 }, 1, [6, 3, 6])[0]).toBe(2.7);
    const turned = waitingPosition({ at: [0, 0, 0], facing: 90 }, 1, [6, 3, 6]);
    expect(turned[0]).toBeCloseTo(0); expect(turned[2]).toBeCloseTo(-0.7);
  });
});

describe("scene layout", () => {
  const scene = (objects: HomePart[], kinds: HomeScene["kinds"] = {}): HomeScene => ({ version: 1, room: { size: [6, 3, 6], floor: "#000000", walls: "#ffffff" }, kinds, objects });
  it("expands kinds and nested kinds (a group's size scales nothing), and refuses a kind that contains itself", () => {
    const layout = layoutScene(scene([{ kind: "pair", size: [2, 2, 2] }], {
      leg: { parts: [{ shape: "box", size: [0.1, 1, 0.1] }] },
      pair: { parts: [{ kind: "leg", at: [-1, 0, 0] }, { kind: "leg", at: [1, 0, 0] }, { kind: "pair" }] },
    }));
    const pair = layout.roots[0];
    expect(pair.type).toBe("group");
    expect(pair.children.map((c) => c.children.length)).toEqual([1, 1, 0]);
    expect(pair.box).toEqual({ min: [-1.05, 0, -0.05], max: [1.05, 1, 0.05] });
  });
  it("rests `on` another object's top centre, and stands a broken or looping `on` in the room", () => {
    const layout = layoutScene(scene([
      { id: "desk", shape: "box", size: [2, 0.8, 1], at: [1, 0, 1] },
      { id: "lamp", shape: "cylinder", size: [0.2, 0.5, 0.2], on: "desk", at: [0.5, 0, 0] },
      { id: "bulb", shape: "sphere", size: [0.1, 0.1, 0.1], on: "lamp" },
      { id: "a", shape: "box", on: "b" }, { id: "b", shape: "box", on: "a" },
      { id: "c", shape: "box", on: "missing" }, { id: "d", shape: "box", on: "d" },
    ]));
    const desk = layout.roots.find((n) => n.carried.length)!;
    expect(desk.carried[0].at).toEqual([0.5, 0.8, 0]);
    expect(desk.carried[0].carried[0].at).toEqual([0, 0.5, 0]);
    expect(layout.unresolved.sort()).toEqual(["a", "b", "c", "d"]);
    expect(layout.roots).toHaveLength(5);
  });
  it("rests on a shape's own height (its parts aside), and on the centre of the top of a group's box, in its turned frame", () => {
    const layout = layoutScene(scene([
      { id: "box", shape: "box", size: [1, 0.5, 1], parts: [{ shape: "box", size: [0.1, 2, 0.1], at: [0.4, 0, 0] }] },
      { on: "box", shape: "box", at: [0, 0, 0] },
      // `size` on a group means nothing.
      { id: "table", turn: [0, 0, 90], size: [5, 5, 5], parts: [{ shape: "box", size: [0.4, 1, 0.6], at: [1, 0, 0] }] },
      { on: "table", shape: "box", at: [0.1, 0, 0] },
    ]));
    const [box, table] = layout.roots;
    expect(box.carried[0].at).toEqual([0, 0.5, 0]);
    expect(table.box).toEqual({ min: [0.8, 0, -0.3], max: [1.2, 1, 0.3] });
    expect(table.carried[0].at[0]).toBeCloseTo(1.1);
    expect(table.carried[0].at[1]).toBeCloseTo(1);
    expect(table.carried[0].at[2]).toBeCloseTo(0);
  });
  it("scales a part and everything in it uniformly, not what rests on it", () => {
    const layout = layoutScene(scene([
      { id: "big", scale: 2, parts: [{ shape: "box", size: [1, 1, 1], at: [1, 0, 0] }] },
      { on: "big", shape: "box", size: [0.2, 0.2, 0.2] },
      { id: "tall", shape: "box", size: [1, 0.5, 1], scale: 3 },
      { on: "tall", shape: "box" },
    ]));
    const [big, tall] = layout.roots;
    expect(big.box).toEqual({ min: [1, 0, -1], max: [3, 2, 1] });
    expect(big.carried[0].at).toEqual([2, 2, 0]);
    expect(big.carried[0].scale).toBe(1);
    expect(tall.carried[0].at).toEqual([0, 1.5, 0]);
  });
  it("keeps to a node budget", () => {
    const many = Array.from({ length: 50 }, () => ({ shape: "box" as const }));
    expect(layoutScene(scene(many), 20).count).toBe(20);
  });
  it("computes boxes the way three.js places them", () => {
    const turn: [number, number, number] = [20, 35, -50], at: [number, number, number] = [0.3, 1, -0.4];
    const ours = transformBox({ min: [-0.5, 0, -0.25], max: [0.5, 2, 0.25] }, at, turn, [1, 1, 1]);
    const group = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 2, 0.5).translate(0, 1, 0));
    group.add(mesh); mesh.position.set(...at); mesh.rotation.set(...turn.map((d) => d * Math.PI / 180) as [number, number, number]);
    const theirs = new Box3().setFromObject(group, true);
    for (let i = 0; i < 3; i++) { expect(ours.min[i]).toBeCloseTo(theirs.min.getComponent(i), 5); expect(ours.max[i]).toBeCloseTo(theirs.max.getComponent(i), 5); }
    expect(rotationRows([0, 0, 0])).toEqual([[1, -0, 0], [0, 1, -0], [0, 0, 1]]);
  });
  it("a window is its own kind of part, framed in its colour", () => {
    const [node] = layoutScene(scene([{ window: true, size: [1.6, 1.2, 0.08] }])).roots;
    expect(node.type).toBe("window");
    expect(node.color).toBe("#f1ead9");
  });
});

describe("the sky outside", () => {
  it("by the viewer's clock when the daemon reports none: clear, phase by hour", () => {
    const at = (h: number, m = 0) => localSky(new Date(2026, 10, 15, h, m));
    expect([at(3).phase, at(6, 30).phase, at(12).phase, at(18, 30).phase, at(22).phase]).toEqual(["night", "dawn", "day", "dusk", "night"]);
    expect(at(12, 30).progress).toBeCloseTo(0.5);
    expect(at(0, 30).progress).toBeCloseTo(0.5);
    expect(at(12).weather).toBe("clear");
    expect(at(12).known).toBe(false);
    expect(weatherWords(at(12))).toBe("");
  });
  it("as reported, clamped", () => {
    expect(skyOf(idle({ sky: { weather: "storm", phase: "day", progress: 3, tempC: -4.6 } }), NOW)).toEqual({ weather: "storm", phase: "day", progress: 1, tempC: -4.6, known: true });
  });
  it("dims and cools the room's light at night and in heavy weather, a little", () => {
    const day = skyLight({ weather: "clear", phase: "day", progress: 0.5, known: true });
    const night = skyLight({ weather: "clear", phase: "night", progress: 0.5, known: true });
    const storm = skyLight({ weather: "storm", phase: "day", progress: 0.5, known: true });
    expect(day).toEqual({ factor: 1, tint: "#b9c6d8", tintAmount: 0 });
    expect(night.factor).toBeLessThan(0.7); expect(night.factor).toBeGreaterThan(0.5);
    expect(storm.factor).toBeLessThan(0.8); expect(storm.tintAmount).toBeGreaterThan(0);
  });
});

describe("snapshot", () => {
  it("counts decoded bytes and echoes only a valid request id", () => {
    expect(base64Bytes(Buffer.from("hello!").toString("base64"))).toBe(6);
    expect(base64Bytes(Buffer.from("hello").toString("base64"))).toBe(5);
    expect(base64Bytes(Buffer.from("hell").toString("base64"))).toBe(4);
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(snapshotBody(id, "r", "AAAA")).toEqual({ requestId: id, revision: "r", png: "AAAA" });
    expect(snapshotBody("look-1", "r", "AAAA")).toEqual({ revision: "r", png: "AAAA" });
  });
  it("reads /home once a minute while visible, counting reads made for other reasons", () => {
    expect(homeReadDue(NOW - 59_000, NOW, false)).toBe(false);
    expect(homeReadDue(NOW - 60_000, NOW, false)).toBe(true);
    expect(homeReadDue(NOW - 600_000, NOW, true)).toBe(false);
  });
  it("routes #home", () => {
    expect(isHomeHash("#home")).toBe(true);
    expect(isHomeHash("#study/todos")).toBe(false);
  });
});

describe("the starter room", () => {
  const all: HomePart[] = [];
  const walk = (part: HomePart) => { all.push(part); part.parts?.forEach(walk); };
  STARTER_SCENE.objects.forEach(walk);
  Object.values(STARTER_SCENE.kinds ?? {}).forEach((kind) => kind.parts.forEach(walk));
  const whens = all.flatMap((part) => part.reactions ?? []).map((r) => r.when);
  it("is valid and resolves completely", () => {
    expect(homeSceneSchema.safeParse(STARTER_SCENE).success).toBe(true);
    expect(layoutScene(STARTER_SCENE).unresolved).toEqual([]);
    const spots = STARTER_SCENE.spots ?? {}, cast = STARTER_SCENE.characters!;
    for (const spot of [cast.tomo!.spot, ...cast.tomo!.rules!.map((r) => r.spot), ...cast.visitors!.spots, cast.visitors!.overflow!, cast.pet!.spot]) expect(spots[spot!]).toBeDefined();
    for (const kind of [cast.tomo!.kind, cast.visitors!.kind, ...Object.values(cast.visitors!.kinds!), cast.pet!.kind]) expect(layoutKind(STARTER_SCENE, kind, kind)).not.toBeNull();
    for (const part of all) if (part.kind) expect(STARTER_SCENE.kinds![part.kind]).toBeDefined();
  });
  it("uses every part of the format at least once (it is the worked example), except a picture", () => {
    for (const shape of SHAPES) expect(all.some((p) => p.shape === shape)).toBe(true);
    for (const reaction of REACTIONS) expect(all.some((p) => p.reactions?.some((r) => r.do === reaction))).toBe(true);
    expect(all.some((p) => p.window)).toBe(true);
    expect(all.some((p) => p.kind && p.scale !== undefined)).toBe(true);
    // `size` means nothing on a group or kind instance (the checker warns): the starter never relies on it.
    expect(all.filter((p) => !p.shape && !p.picture && !p.sign && !p.window && p.size)).toEqual([]);
    expect(all.some((p) => p.on)).toBe(true);
    expect(all.some((p) => p.turn) && all.some((p) => p.kind && p.at)).toBe(true);
    expect(all.some((p) => !p.shape && !p.kind && !p.sign && !p.window && p.parts)).toBe(true);
    const signs = all.filter((p) => p.sign).map((p) => p.sign).join(" ");
    expect(signs).toMatch(/\{task\}/); expect(signs).toMatch(/\{status\}|\{idle\}|\{next_job\}/);
    expect(whens.some((w) => Array.isArray(w))).toBe(true);
    expect(whens.flat().some((w) => w.startsWith("not:"))).toBe(true);
    expect(whens.flat().some((w) => w.startsWith("weather:"))).toBe(true);
    expect(whens.flat().some((w) => w.startsWith("pet:") || w.startsWith("not:pet:"))).toBe(true);
    expect(STARTER_SCENE.light && STARTER_SCENE.room.backdrop && STARTER_SCENE.characters?.visitors?.overflow && STARTER_SCENE.characters.visitors.kinds).toBeTruthy();
    expect(all.some((p) => p.picture)).toBe(false);
  });
  it("lays out its characters in their spots, Tomo facing the default view's side at its desk", () => {
    const tomo = layoutKind(STARTER_SCENE, "tomo", "tomo") as LayoutNode;
    expect(tomo.box.max[1]).toBeGreaterThan(0.6);
    // The default camera looks from AZIMUTH_DEFAULT (0.72 rad, about 41°); a face within 70° of it is seen.
    for (const spot of ["desk-chair", "cushion"]) {
      const facing = STARTER_SCENE.spots![spot].facing ?? 0;
      expect(Math.abs(((facing - 41 + 540) % 360) - 180)).toBeLessThan(70);
    }
  });
});
