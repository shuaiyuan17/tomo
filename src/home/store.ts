import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, watch, writeSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import { checkHomeScene, checkHomeSceneText, type HomeCheckResult } from "./check.js";
import { ASSETS_DIR, describeHomeReadError, HOME_DIR, homeDirectory, listHomeAssets, readHomeJson, SCENE_FILE, type HomeAssets } from "./files.js";
import { MAX_SCENE_BYTES, type HomeScene } from "./scene.js";
import { STARTER_SCENE } from "./starter.js";

/**
 * The home's scene, as the daemon serves it: always a valid scene.
 *
 * Reads `<workspace>/home/scene.json` (files.ts: bounded, a plain file in
 * the real `home` directory), checks it whole (check.ts) against the
 * pictures in `home/assets/`, and keeps the LAST GOOD scene, persisted to
 * `lastGoodPath` so a restart with a broken file still shows a room. A
 * broken write (Tomo's or anyone's) never takes the room down: the view
 * keeps the last good scene and lists the problems. With no good scene ever,
 * the starter is shown.
 *
 * Changes are noticed by fs.watch on the workspace, `home/` and
 * `home/assets/` (debounced), with a cheap stat poll as the fallback for
 * platforms or moments where a watch is missing (the folder does not exist
 * yet, was deleted or replaced). Neither ever throws or spins: a failing
 * watch is dropped and re-armed by the next poll.
 */

export interface HomeView {
  scene: HomeScene;
  /** Changes whenever the served scene, its problems or an asset file does. */
  revision: string;
  /** The served scene is the starter room (the built-in fallback, or a file still identical to it). */
  starter: boolean;
  /** Why the file on disk is not what is shown; absent when it is. */
  problems?: string[];
  warnings?: string[];
}

export interface HomeSceneStoreOptions {
  workspaceDir: string;
  /** Where the last good scene is kept across restarts. */
  lastGoodPath: string;
  debounceMs?: number;
  pollMs?: number;
}

export const HOME_DEBOUNCE_MS = 200;
export const HOME_POLL_MS = 5_000;

export class HomeSceneStore {
  private current: HomeView;
  private lastGood: HomeScene | undefined;
  private signature = "";
  private watchers = new Map<string, FSWatcher>();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(view: HomeView) => void>();
  private readonly debounceMs: number;
  private readonly pollMs: number;

  constructor(private readonly options: HomeSceneStoreOptions) {
    this.debounceMs = options.debounceMs ?? HOME_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? HOME_POLL_MS;
    this.lastGood = this.loadLastGood();
    this.current = this.compose(this.lastGood ?? STARTER_SCENE, [], [], { usable: [], refused: new Map() }, this.lastGood === undefined);
  }

  /** Creates the starter file if there is none, loads, and starts watching. */
  start(): void {
    ensureStarterScene(this.options.workspaceDir);
    this.refresh();
    this.arm();
    this.poll = setInterval(() => { try { this.arm(); if (this.statSignature() !== this.signature) this.refresh(); } catch { /* next tick */ } }, this.pollMs);
    this.poll.unref?.();
  }
  stop(): void {
    clearInterval(this.poll);
    clearTimeout(this.debounce);
    for (const watcher of this.watchers.values()) try { watcher.close(); } catch { /* gone */ }
    this.watchers.clear();
  }
  onChange(fn: (view: HomeView) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  view(): HomeView { return this.current; }

  /** Re-reads now (synchronously) and returns the view; listeners hear of a new revision. */
  refresh(): HomeView {
    let next: HomeView;
    try {
      this.signature = this.statSignature();
      const assets = listHomeAssets(this.options.workspaceDir);
      const result = this.readAndCheck(assets);
      if (result.ok && result.scene) {
        if (!this.lastGood || !isDeepStrictEqual(this.lastGood, result.scene)) {
          this.lastGood = result.scene;
          this.saveLastGood(result.scene);
        }
        next = this.compose(result.scene, [], result.warnings, assets, false);
      } else {
        next = this.compose(this.lastGood ?? STARTER_SCENE, result.problems, result.warnings, assets, this.lastGood === undefined);
      }
    } catch (error) {
      log.warn({ err: error }, "Home scene could not be refreshed; keeping the current one");
      return this.current;
    }
    const changed = next.revision !== this.current.revision;
    this.current = next;
    if (changed) for (const fn of this.listeners) try { fn(next); } catch { /* a listener never breaks the store */ }
    return next;
  }

  /** The live file, checked against the given assets. */
  private readAndCheck(assets: HomeAssets): HomeCheckResult {
    const read = readHomeJson(this.options.workspaceDir, SCENE_FILE);
    if (!read.ok) return { ok: false, problems: [describeHomeReadError(SCENE_FILE, read.error)], warnings: [] };
    return checkHomeSceneText(read.text, { assets: new Set(assets.usable.map((a) => a.name)), refusedAssets: assets.refused });
  }

  private compose(scene: HomeScene, problems: string[], warnings: string[], assets: HomeAssets, fallback: boolean): HomeView {
    const hash = createHash("sha256").update(JSON.stringify(scene)).update("\0").update(JSON.stringify(problems));
    for (const asset of assets.usable) hash.update(`\0${asset.name}:${asset.size}:${asset.mtimeMs}:${asset.ino}`);
    return {
      scene, revision: hash.digest("hex").slice(0, 32),
      starter: fallback || isDeepStrictEqual(scene, STARTER_SCENE),
      ...(problems.length ? { problems } : {}), ...(warnings.length ? { warnings } : {}),
    };
  }

  private loadLastGood(): HomeScene | undefined {
    try {
      const fd = openSync(this.options.lastGoodPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_SCENE_BYTES * 2) return undefined;
        const text = readFileSync(fd, "utf8");
        // Re-checked like any scene (no asset check: pictures are checked against the folder when served).
        const result = checkHomeScene(JSON.parse(text));
        return result.ok ? result.scene : undefined;
      } finally { closeSync(fd); }
    } catch { return undefined; }
  }
  private saveLastGood(scene: HomeScene): void {
    try {
      mkdirSync(dirname(this.options.lastGoodPath), { recursive: true });
      writeFileAtomicSync(this.options.lastGoodPath, `${JSON.stringify(scene)}\n`, { mode: 0o600 });
    } catch (error) { log.warn({ err: error }, "Could not save the last good home scene; it is kept in memory only"); }
  }

  /** Cheap: lstat of the folders, the scene and each asset entry. */
  private statSignature(): string {
    const parts: string[] = [];
    const stat = (path: string) => { try { const s = lstatSync(path); parts.push(`${s.ino}:${s.size}:${s.mtimeMs}:${s.mode}`); } catch { parts.push("-"); } };
    const home = join(this.options.workspaceDir, HOME_DIR);
    stat(home);
    stat(join(home, SCENE_FILE));
    stat(join(home, ASSETS_DIR));
    for (const asset of listHomeAssets(this.options.workspaceDir).usable) parts.push(`${asset.name}:${asset.size}:${asset.mtimeMs}:${asset.ino}`);
    return parts.join("|");
  }

  /** (Re)arms the watches that are missing; one that errors is closed and re-armed by a later poll. */
  private arm(): void {
    const home = homeDirectory(this.options.workspaceDir);
    const assets = homeDirectory(this.options.workspaceDir, ASSETS_DIR);
    const wanted = new Set([this.options.workspaceDir, ...(home ? [home] : []), ...(assets ? [assets] : [])]);
    for (const [path, watcher] of this.watchers) {
      if (!wanted.has(path)) { try { watcher.close(); } catch { /* gone */ } this.watchers.delete(path); }
    }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue;
      try {
        // The workspace itself only matters for `home` appearing, going or being replaced.
        const root = path === this.options.workspaceDir;
        const watcher = watch(path, { persistent: false }, (_event, name) => { if (!root || !name || String(name) === HOME_DIR) this.schedule(); });
        watcher.on("error", () => { try { watcher.close(); } catch { /* gone */ } if (this.watchers.get(path) === watcher) this.watchers.delete(path); this.schedule(); });
        this.watchers.set(path, watcher);
      } catch { /* not there (yet): the poll notices */ }
    }
  }
  private schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      try { this.arm(); if (this.statSignature() !== this.signature) this.refresh(); } catch { /* the poll retries */ }
    }, this.debounceMs);
    this.debounce.unref?.();
  }
}

/**
 * Writes the starter room to `home/scene.json` when there is no file there,
 * so Tomo has something to read and edit. Never overwrites (O_EXCL), never
 * follows a link, and never creates `home` through one.
 */
export function ensureStarterScene(workspaceDir: string): boolean {
  try {
    const home = join(workspaceDir, HOME_DIR);
    try {
      const stat = lstatSync(home);
      if (!stat.isDirectory()) return false;
    } catch {
      mkdirSync(home, { mode: 0o755 });
    }
    if (!homeDirectory(workspaceDir)) return false;
    try { if (!lstatSync(join(home, ASSETS_DIR)).isDirectory()) { /* something else is there: leave it */ } }
    catch { mkdirSync(join(home, ASSETS_DIR)); }
    const fd = openSync(join(home, SCENE_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeSync(fd, `${JSON.stringify(STARTER_SCENE, null, 2)}\n`); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}
