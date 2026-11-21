import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_SKILL_VALUES, renderSkillTemplate } from "../src/home/skill.js";
import { checkHomeScene, PET_MOODS } from "../src/home/check.js";
import { CONDITIONS, MAX_DEPTH, MAX_OBJECTS, MAX_SIGN_CHARS, REACTIONS, SHAPES, SIGN_VALUES } from "../src/home/scene.js";
import { STARTER_SCENE } from "../src/home/starter.js";
import { syncBundledSkills } from "../src/workspace/bundled-skills.js";
import { buildSystemPrompt, HOME_NOTE } from "../src/workspace/index.js";

const DEFAULTS = join(import.meta.dirname, "..", "defaults", "skills");
const TEMPLATE = readFileSync(join(DEFAULTS, "home", "SKILL.md"), "utf8");
const RENDERED = renderSkillTemplate(TEMPLATE);
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe("the tomo-home skill", () => {
  it("lists every condition, reaction, shape and sign value of scene.ts, from the constants", () => {
    for (const condition of CONDITIONS) expect(RENDERED).toContain(`- \`${condition}\`: `);
    for (const reaction of REACTIONS) expect(RENDERED).toContain(`- \`${reaction}\`: `);
    for (const shape of SHAPES) expect(RENDERED).toContain(`\`${shape}\``);
    for (const value of SIGN_VALUES) expect(RENDERED).toContain(`- \`{${value}}\`: `);
    expect(RENDERED).toContain(`at most ${MAX_OBJECTS}`);
    expect(RENDERED).toContain(`at most ${MAX_DEPTH} levels`);
    expect(RENDERED).toContain(`at most ${MAX_SIGN_CHARS} characters`);
  });
  it("the bundled file does not retype the lists (they are placeholders)", () => {
    for (const name of ["conditions", "reactions", "sign-values", "shapes", "limits", "starter"]) expect(TEMPLATE).toContain(`{{home:${name}}}`);
    expect(TEMPLATE).not.toContain("- `tool:shell`");
    expect(TEMPLATE).not.toContain("- `pulse`");
  });
  it("names no reaction or condition the format does not have", () => {
    for (const [, name] of RENDERED.matchAll(/"do": "([a-z]+)"/g)) expect(REACTIONS).toContain(name);
    for (const [, name] of RENDERED.matchAll(/"when": "([a-z:-]+)"/g)) {
      const bare = name.replace(/^not:/, "");
      if (bare.startsWith("pet:")) expect(PET_MOODS as readonly string[]).toContain(bare.slice(4));
      else expect(CONDITIONS as readonly string[]).toContain(bare);
    }
  });
  it("carries the starter as its worked example, whatever the starter is", () => {
    expect(RENDERED).toContain(JSON.stringify(STARTER_SCENE, null, 2));
    expect(RENDERED).not.toMatch(/\{\{home:/);
  });
  it("explains scale and the reaction defaults, from the constants", async () => {
    const { REACTION_DEFAULTS } = await import("../src/home/scene.js");
    expect(RENDERED).toContain("`scale` (0.1–10, default 1)");
    for (const [name, d] of Object.entries(REACTION_DEFAULTS) as Array<[string, { amount?: number; max?: number; speed?: number }]>) {
      const line = RENDERED.split("\n").find((l) => l.startsWith(`- \`${name}\`: `))!;
      if (d.amount !== undefined) expect(line).toContain(`default amount ${d.amount}`);
      if (d.max !== undefined) expect(line).toContain(`at most ${d.max}`);
      if (d.speed !== undefined) expect(line).toContain(`speed ${d.speed}`);
    }
  });
  it("explains pet rules with a nest, and its example is a scene that checks clean", () => {
    expect(RENDERED).toContain('"rules": [{ "when": "pet:sleeping", "spot": "nest-bed" }]');
    expect(RENDERED).toContain("A nest is just an object you build");
    for (const mood of PET_MOODS) expect(RENDERED).toContain(`\`${mood}\``);
    const example = /\*\*Example: a nest[\s\S]*?```json\n([\s\S]*?)```/.exec(RENDERED)![1];
    const fragment = JSON.parse(`{${example}}`);
    const result = checkHomeScene({ version: 1, room: { size: [6, 3, 6], floor: "#a9825b", walls: "#d9cdb6" },
      kinds: { cat: { parts: [{ shape: "sphere", size: [0.3, 0.25, 0.4] }] } }, ...fragment });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("explains walk and wander from the constants, and its example is a scene that checks clean", async () => {
    const { WALK_RADIUS_LIMITS, WALK_RULE_FACTOR, WALK_SPEED_LIMITS, WANDER_EVERY_LIMITS, WANDER_SPOT_LIMITS } = await import("../src/home/scene.js");
    const { NAV_PET, NAV_WALKER } = await import("../src/home/nav.js");
    expect(TEMPLATE).toContain("{{home:walk-wander}}");
    const line = (name: string) => RENDERED.split("\n").find((l) => l.startsWith(`- \`${name}\`: `)) ?? "";
    expect(line("walk.speed")).toContain(`${WALK_SPEED_LIMITS.min}–${WALK_SPEED_LIMITS.max}, default ${WALK_SPEED_LIMITS.default}`);
    expect(line("walk.speed")).toContain(`${WALK_RULE_FACTOR} times as fast`);
    expect(line("walk.radius")).toContain(`${WALK_RADIUS_LIMITS.min}–${WALK_RADIUS_LIMITS.max}; default ${NAV_WALKER.radius} for you, ${NAV_PET.radius} for the pet`);
    expect(line("wander.spots")).toContain(`${WANDER_SPOT_LIMITS.min}–${WANDER_SPOT_LIMITS.max} of them`);
    expect(line("wander.every")).toContain(`${WANDER_EVERY_LIMITS.min}–${WANDER_EVERY_LIMITS.max}, default [${WANDER_EVERY_LIMITS.default.join(", ")}]`);
    expect(line("wander.when")).not.toBe("");
    expect(RENDERED).toContain("You wander only while idle");
    expect(RENDERED).toContain("Under the viewer's reduced-motion setting nobody wanders");
    const example = /\*\*Example: you stroll[\s\S]*?```json\n([\s\S]*?)```/.exec(RENDERED)![1];
    const fragment = JSON.parse(`{${example}}`);
    expect(fragment.characters.tomo.wander.every).toEqual([30, 90]);
    const result = checkHomeScene({ version: 1, room: { size: [6, 3, 6], floor: "#a9825b", walls: "#d9cdb6" }, objects: [],
      kinds: { me: { parts: [{ shape: "sphere", size: [0.6, 0.6, 0.6] }] }, cat: { parts: [{ shape: "sphere", size: [0.3, 0.25, 0.4] }] } }, ...fragment });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("explains windows, the weather and pictures", () => {
    expect(RENDERED).toContain('"window": true');
    expect(RENDERED).toContain("conditions hold only when a city is configured");
    expect(RENDERED).toContain("home/assets/");
  });
  it("an unknown placeholder fails rather than ship as braces", () => {
    expect(() => renderSkillTemplate("{{home:nope}}")).toThrow("Unknown skill placeholder");
    expect(Object.keys(HOME_SKILL_VALUES).length).toBeGreaterThan(5);
  });
  it("is shipped as tomo-home, rendered, beside the other bundled skills; retired ones are pruned", () => {
    root = mkdtempSync(join(tmpdir(), "tomo-skills-"));
    const target = join(root, "skills");
    mkdirSync(join(target, "tomo-retired"), { recursive: true });
    mkdirSync(join(target, "mine"), { recursive: true });
    writeFileSync(join(target, "mine", "SKILL.md"), "custom");
    syncBundledSkills(DEFAULTS, target);
    expect(readFileSync(join(target, "tomo-home", "SKILL.md"), "utf8")).toBe(RENDERED);
    expect(readFileSync(join(target, "tomo-lcm", "SKILL.md"), "utf8")).toBe(readFileSync(join(DEFAULTS, "lcm", "SKILL.md"), "utf8"));
    expect(existsSync(join(target, "tomo-retired"))).toBe(false);
    expect(readFileSync(join(target, "mine", "SKILL.md"), "utf8")).toBe("custom");
  });
  it("the always-loaded prompt says the home exists in at most two sentences, owner DM only", () => {
    expect(HOME_NOTE.replace(/^## .*\n+/, "").split(/(?<=\.)\s+/).filter(Boolean)).toHaveLength(2);
    expect(buildSystemPrompt()).toContain(HOME_NOTE);
    expect(buildSystemPrompt({ isGroup: true })).not.toContain("home_check");
  });
});
