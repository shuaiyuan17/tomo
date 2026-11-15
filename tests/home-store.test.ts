import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStarterScene, HomeSceneStore } from "../src/home/store.js";
import { STARTER_SCENE } from "../src/home/starter.js";
import { MAX_SCENE_BYTES, type HomeScene } from "../src/home/scene.js";

let root: string, workspace: string, home: string, lastGood: string;
const stores: HomeSceneStore[] = [];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function mine(name = "Mine"): HomeScene {
  return { version: 1, name, room: { size: [5, 3, 5], floor: "#333333", walls: "#eeeeee" }, objects: [{ id: "cube", shape: "box", at: [0, 0, 0] }] };
}
function store(): HomeSceneStore {
  const s = new HomeSceneStore({ workspaceDir: workspace, lastGoodPath: lastGood, debounceMs: 20, pollMs: 100 });
  stores.push(s);
  return s;
}
const write = (scene: unknown) => writeFileSync(join(home, "scene.json"), typeof scene === "string" ? scene : JSON.stringify(scene));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-home-store-"));
  workspace = join(root, "workspace");
  home = join(workspace, "home");
  lastGood = join(root, "data", "home", "last-good.json");
  mkdirSync(join(workspace, "memory", "private"), { recursive: true });
});
afterEach(() => { for (const s of stores.splice(0)) s.stop(); rmSync(root, { recursive: true, force: true }); });

describe("home scene store", () => {
  it("creates the starter file on first use, and never overwrites one", () => {
    expect(ensureStarterScene(workspace)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "scene.json"), "utf8"))).toEqual(STARTER_SCENE);
    expect(existsSync(join(home, "assets"))).toBe(true);
    write(mine());
    expect(ensureStarterScene(workspace)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "scene.json"), "utf8")).name).toBe("Mine");
  });

  it("does not create the starter through a symlinked home", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, home);
    expect(ensureStarterScene(workspace)).toBe(false);
    expect(existsSync(join(elsewhere, "scene.json"))).toBe(false);
  });

  it("serves the starter file as the starter, then Tomo's scene once it is good", () => {
    const s = store();
    s.start();
    expect(s.view()).toMatchObject({ starter: true, scene: STARTER_SCENE });
    expect(s.view().problems).toBeUndefined();
    write(mine());
    const view = s.refresh();
    expect(view).toMatchObject({ starter: false, scene: mine() });
    expect(JSON.parse(readFileSync(lastGood, "utf8"))).toEqual(mine());
  });

  it("a broken write keeps the last good scene, with the problems; a restart still shows it", () => {
    const s = store();
    s.start();
    write(mine());
    const good = s.refresh();
    write("{ not json");
    const broken = s.refresh();
    expect(broken.scene).toEqual(mine());
    expect(broken.problems?.[0]).toMatch(/not valid JSON/);
    expect(broken.revision).not.toBe(good.revision);
    write({ ...mine(), objects: [{ kind: "nope" }] });
    expect(s.refresh().problems?.[0]).toContain('kind "nope" is not defined');
    s.stop();
    const again = store();
    again.start();
    expect(again.view().scene).toEqual(mine());
    expect(again.view().starter).toBe(false);
    expect(again.view().problems?.length).toBe(1);
  });

  it("with no good scene ever, a broken file shows the starter and says why", () => {
    mkdirSync(home);
    write("[]");
    const s = store();
    s.start();
    expect(s.view().scene).toEqual(STARTER_SCENE);
    expect(s.view().starter).toBe(true);
    expect(s.view().problems?.length).toBeGreaterThan(0);
  });

  it("an unreadable last-good file is ignored, not trusted", () => {
    mkdirSync(join(root, "data", "home"), { recursive: true });
    writeFileSync(lastGood, JSON.stringify({ version: 1, objects: [], script: "x" }));
    mkdirSync(home);
    write("broken");
    const s = store();
    s.start();
    expect(s.view().scene).toEqual(STARTER_SCENE);
  });

  it("refuses a symlinked or hard-linked scene file and an oversized one", () => {
    const s = store();
    s.start();
    write(mine());
    s.refresh();
    const outside = join(workspace, "memory", "private", "secret.json");
    writeFileSync(outside, JSON.stringify(mine("secret")));
    rmSync(join(home, "scene.json"));
    symlinkSync(outside, join(home, "scene.json"));
    expect(s.refresh().problems?.[0]).toContain("is a link");
    expect(s.view().scene.name).toBe("Mine");
    rmSync(join(home, "scene.json"));
    linkSync(outside, join(home, "scene.json"));
    expect(s.refresh().problems?.[0]).toContain("is a link");
    rmSync(join(home, "scene.json"));
    write(" ".repeat(MAX_SCENE_BYTES + 10));
    expect(s.refresh().problems?.[0]).toContain("larger than 256 KiB");
    expect(JSON.stringify(s.view())).not.toContain("secret");
  });

  it("a symlinked home folder reads as missing", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "scene.json"), JSON.stringify(mine("elsewhere")));
    symlinkSync(elsewhere, home);
    const s = store();
    s.start();
    expect(s.view().scene).toEqual(STARTER_SCENE);
    expect(s.view().problems?.[0]).toContain("does not exist");
  });

  it("survives the folder being deleted and replaced, and notices without being asked", async () => {
    const s = store();
    const heard = vi.fn();
    s.onChange(heard);
    s.start();
    write(mine());
    await vi.waitFor(() => expect(s.view().scene.name).toBe("Mine"), { timeout: 3000 });
    rmSync(home, { recursive: true });
    await vi.waitFor(() => expect(s.view().problems?.[0]).toContain("does not exist"), { timeout: 3000 });
    expect(s.view().scene.name).toBe("Mine");
    const fresh = join(workspace, "home-new");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "scene.json"), JSON.stringify(mine("Replaced")));
    renameSync(fresh, home);
    await vi.waitFor(() => expect(s.view().scene.name).toBe("Replaced"), { timeout: 3000 });
    expect(s.view().problems).toBeUndefined();
    expect(heard).toHaveBeenCalled();
  });

  it("does not crash or spin without a workspace at all", () => {
    rmSync(workspace, { recursive: true });
    const s = store();
    s.start();
    expect(s.view().scene).toEqual(STARTER_SCENE);
    expect(s.refresh().problems?.[0]).toContain("does not exist");
  });

  it("the revision covers the asset files; pictures must be usable", () => {
    const s = store();
    s.start();
    write({ ...mine(), objects: [{ picture: "art.png", at: [0, 1, -2.4], size: [1, 1, 0.02] }] });
    expect(s.refresh().problems?.[0]).toContain('picture "art.png" is not in home/assets/');
    writeFileSync(join(home, "assets", "art.png"), "not a png at all");
    expect(s.refresh().problems?.[0]).toContain("cannot be used: its content is not the kind of image");
    writeFileSync(join(home, "assets", "art.png"), PNG);
    const first = s.refresh();
    expect(first.problems).toBeUndefined();
    writeFileSync(join(home, "assets", "other.png"), PNG);
    expect(s.refresh().revision).not.toBe(first.revision);
  });
});
