import { Color, DirectionalLight, Group, HemisphereLight, MathUtils, Mesh, PCFSoftShadowMap, PerspectiveCamera, PointLight, Scene, Spherical, Vector3, WebGLRenderer, type Object3D } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { HomeScene } from "../../../../src/home/scene.js";
import type { HomeSubagent } from "../../../../src/home/status.js";
import { fillSign, partEffects, seatVisitors, visitorKind, type Conditions, type SignValues, type Vec3 } from "../evaluate.js";
import { MAX_WAITING_DRAWN, waitingPosition } from "../../../../src/home/waiting.js";
import { layoutKind, layoutScene } from "../layout.js";
import { buildNodes, redrawSigns, retarget, signPixels, signScaleFor, stepPart, updateSigns, type Built } from "./build.js";
import { Resources, SIGN_FONT } from "./resources.js";
import { drawSky } from "./sky-canvas.js";
import { skyLight, skyMoves, type Sky } from "../sky.js";
import { base64Bytes } from "../snapshot.js";
import { planMove, poseAt, smooth, type WalkPlan, type WalkPose } from "../walk.js";
import { placeScene, type Placement } from "../../../../src/home/geometry.js";
import { buildNavGrid, findRoute, type NavGrid, type WalkerSize } from "../../../../src/home/nav.js";
import { walkerOf } from "../../../../src/home/reach.js";
import { WALK_RULE_FACTOR, WALK_SPEED_DEFAULT } from "../contract.js";
import { placeCharacter, type Placing, type Random, type WanderState } from "../wander.js";

/**
 * The room as three.js draws it. It renders only while something changes
 * or moves, and not at all while paused (tab hidden, page left). Everything
 * it made is released by `dispose`.
 */

export interface StageState { conditions: Conditions; values: SignValues; subagents: HomeSubagent[]; hasPet: boolean; sky: Sky }

/**
 * The default view looks from AZIMUTH_DEFAULT (radians around the room, 0 =
 * straight on) and is framed so the room fits from anywhere between
 * AZIMUTH_MIN and AZIMUTH_MAX. The owner can then orbit all the way round.
 */
export const AZIMUTH_MIN = 0.05, AZIMUTH_MAX = 1.45, AZIMUTH_DEFAULT = 0.72;
/** How high the owner can tilt the view (radians above the floor): never under it, never straight down. */
export const ELEVATION_MIN = 10 * Math.PI / 180, ELEVATION_MAX = 85 * Math.PI / 180;
/** How far the owner can zoom out, as a multiple of the default distance. */
export const ZOOM_OUT_MAX = 1.8;
/**
 * The owner's camera limits for a room `size` [w, h, d] whose default view is
 * `distance` away: the target may wander a quarter of the room from its centre,
 * and the camera stays outside the room's walls wherever the target is.
 */
export function viewLimits(size: readonly [number, number, number], distance: number): { minDistance: number; maxDistance: number; maxTargetRadius: number } {
  const [w, , d] = size;
  const maxTargetRadius = Math.max(w, d) / 4;
  const minDistance = Math.min(distance, Math.hypot(w, d) / 2 + maxTargetRadius + 0.3);
  return { minDistance, maxDistance: distance * ZOOM_OUT_MAX, maxTargetRadius };
}
/** The camera as the owner left it: distance from what it looks at, angle round the room and above the floor (radians). */
export interface StageView { distance: number; azimuth: number; elevation: number; target: Vec3 }
/**
 * How far above the room the camera looks down (radians): the reference
 * angle on a wide view, steeper on a tall one, so a phone in portrait sees
 * the room fill its height instead of a strip with dark bands around it.
 */
export function elevationFor(aspect: number): number {
  const t = Math.min(1, Math.max(0, (1.1 - aspect) / 0.45));
  return 0.5 + t * 0.55;
}
const FOV = 36;
const GLOW_LIGHTS = 2;
const RAD = Math.PI / 180;

interface Character {
  key: string; kind: string; anchor: Group; body: Built | null;
  /** Its size for finding a way round the furniture. */
  walker: WalkerSize;
  /** Where it is headed (its spot), and the way it will face there. */
  to: Vec3; toYaw: number;
  /** The move under way (see walk.ts), started at `start`; null when it is standing at `to`. */
  plan: WalkPlan | null; start: number;
  /** Tomo and the pet: the spot it is at or heading to, why (wander.ts), and its wander (null when not wandering). */
  spot?: string; by?: Placing["by"]; wander: WanderState | null;
  appear: number; leaving: boolean; task: string;
}

export class HomeStage {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 0.1, 200);
  private hemi = new HemisphereLight("#fff4e0", "#5b4a3a", 2);
  private sun = new DirectionalLight("#ffffff", 2);
  private glowLights: PointLight[] = [];
  private resources: Resources | null = null;
  private world: Group | null = null;
  private built: Built | null = null;
  private home: HomeScene | null = null;
  private characters = new Map<string, Character>();
  /** Where each size of walker can go in this scene: built when first needed, kept until the scene changes. */
  private grids = new Map<WalkerSize, NavGrid | null>();
  private placement: Placement | null = null;
  private seats = new Map<string, number>();
  /** Whether a walker can walk from one spot to another, per scene (for picking where to wander). */
  private walkable = new Map<string, boolean>();
  /** Wakes the stage when a wander's stay is over; `wanderDue` if that happened while paused. */
  private wanderTimer: ReturnType<typeof setTimeout> | null = null;
  private wanderDue = false;
  /** Where the next wander goes (wander.ts takes its dice from the caller). */
  random: Random = Math.random;
  private state: StageState | null = null;
  private light = { hemi: 2, sun: 2, color: new Color("#fff6ea") };
  private skyDrawnAt = -1;
  private frame = 0;
  private lastTime = 0;
  /** Draw every frame (something walks) / until then (the owner is turning the view). */
  private fast = false;
  private fastUntil = 0;
  private paused = false;
  private disposed = false;
  private distance = 12;
  private elevation = 0.5;
  /** The default view looks here (the room's centre, a little up). */
  private center = new Vector3();
  private size: [number, number, number] = [6, 3, 6];
  private readonly controls: OrbitControls;
  /** The owner moved the view: a resize keeps it (within the new limits) instead of reframing. */
  private moved = false;
  /** A gesture is under way. */
  private held = false;
  private width = 1;
  private height = 1;
  private reduced = false;
  /** Told whenever the view changes (the owner's camera). */
  onView: ((view: StageView) => void) | undefined;
  get reducedMotion(): boolean { return this.reduced; }
  /** Reduced motion: the view stops where the owner lets go (no inertia). */
  set reducedMotion(value: boolean) {
    const changed = value !== this.reduced;
    this.reduced = value; this.controls.enableDamping = !value;
    // Wandering stops (it stands at its spot at once) or starts again.
    if (changed && this.state && this.home && this.built) { this.placeCharacters(this.state, false); this.invalidate(); }
  }

  constructor(canvas: HTMLCanvasElement, private readonly assetUrl: (name: string) => string) {
    // Throws without WebGL: the caller says so in words.
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // Orbit (one finger / left drag), zoom (pinch / wheel) and pan (two fingers /
    // right or Shift drag). The canvas gets touch-action: none, so a gesture on
    // the room never scrolls the page.
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, zoomSpeed: 0.8, rotateSpeed: 0.8,
      minPolarAngle: Math.PI / 2 - ELEVATION_MAX, maxPolarAngle: Math.PI / 2 - ELEVATION_MIN });
    this.controls.addEventListener("start", () => { this.held = true; });
    this.controls.addEventListener("end", () => { this.held = false; });
    this.controls.addEventListener("change", () => { if (this.held) this.moved = true; this.invalidate(); this.tellView(); });
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    // A fixed pool: adding or removing lights would recompile every material.
    for (let i = 0; i < GLOW_LIGHTS; i++) { const light = new PointLight("#ffffff", 0, 3.5, 1.6); this.glowLights.push(light); this.scene.add(light); }
    document.fonts?.load(`600 32px ${SIGN_FONT}`).then(() => { if (this.built && !this.disposed) { redrawSigns(this.allSigns()); this.invalidate(); } }, () => {});
  }

  /** A new scene: everything is built again (characters start where they belong, without walking there). */
  setScene(home: HomeScene, revision: string): void {
    this.clearWorld();
    this.home = home;
    this.grids.clear(); this.placement = null; this.walkable.clear();
    this.resources = new Resources((name) => `${this.assetUrl(name)}?r=${encodeURIComponent(revision)}`, () => this.invalidate());
    const layout = layoutScene(home);
    const [w, h, d] = home.room.size;
    this.world = new Group();
    this.world.add(this.roomShell(w, h, d));
    // Characters' bodies count toward the sign budget roughly as one visitor per seat.
    this.built = buildNodes(layout.roots, this.resources, signScaleFor(signPixels(layout.roots) * 1.5));
    this.world.add(this.built.root);
    this.scene.add(this.world);
    this.scene.background = new Color(home.room.backdrop ?? "#1b1a19");
    const light = home.light ?? {};
    const level = light.level ?? 0.6;
    // The scene's own light; the sky outside then dims and tints it a little (applySky).
    this.light = { hemi: 0.9 + level * 1.6, sun: 0.6 + level * 2.2, color: new Color(light.color ?? "#fff6ea") };
    this.applySky();
    const angle = (light.angle ?? 35) * RAD, reach = Math.max(w, d) * 1.1 + 4;
    this.sun.position.set(Math.sin(angle) * reach, h + reach * 0.9, Math.cos(angle) * reach);
    const half = Math.hypot(w, d) / 2 + 1;
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: reach * 3 + h });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
    this.size = [w, h, d];
    this.center.set(0, h * 0.28, 0);
    this.fit();
    if (this.state) this.setState(this.state, true);
    this.invalidate();
  }

  private roomShell(w: number, h: number, d: number): Object3D {
    const room = this.home!.room, resources = this.resources!;
    const shell = new Group();
    const slab = (size: Vec3, at: Vec3, color: string) => {
      const mesh = new Mesh(resources.geometry("box"), resources.shared(color));
      mesh.scale.set(...size); mesh.position.set(...at); mesh.receiveShadow = true; mesh.castShadow = true; shell.add(mesh);
    };
    const side = "#" + new Color(room.walls).multiplyScalar(0.9).getHexString();
    slab([w + 0.2, 0.2, d + 0.2], [-0.1, -0.2, -0.1], room.floor);
    slab([w + 0.2, h, 0.2], [-0.1, 0, -d / 2 - 0.1], room.walls);
    slab([0.2, h, d], [-w / 2 - 0.1, 0, 0], side);
    return shell;
  }

  /** What holds now: reactions retarget, signs redraw, characters head for their spots. */
  setState(state: StageState, immediate = false): void {
    this.state = state;
    if (!this.home || !this.built) return;
    for (const part of this.allParts()) retarget(part, partEffects(part.node.reactions, state.conditions));
    this.placeCharacters(state, immediate);
    updateSigns(this.built.signs, (sign) => fillSign(sign.node.sign!, state.values));
    this.applySky();
    this.drawWindows(this.now(), true);
    for (const character of this.characters.values()) if (character.body) updateSigns(character.body.signs, (sign) => fillSign(sign.node.sign!, { ...state.values, task: character.task }));
    if (immediate || this.reducedMotion) for (const part of this.allParts()) stepPart(part, 1, this.now(), true);
    this.invalidate();
  }

  private placeCharacters(state: StageState, immediate: boolean): void {
    const home = this.home!, spots = home.spots ?? {}, cast = home.characters ?? {};
    type Want = { kind: string; at: Vec3; facing: number; task: string; walker: WalkerSize; spot?: string; by?: Placing["by"]; wander?: WanderState | null; speed?: number; plan?: WalkPlan };
    const wanted = new Map<string, Want>();
    const spotAt = (name: string | undefined) => name ? spots[name] : undefined;
    const now = this.now();
    if (cast.visitors) {
      const walker = walkerOf("visitors", home);
      const seating = seatVisitors(state.subagents, cast.visitors.spots.length, this.seats);
      this.seats = seating.seated;
      const overflow = spotAt(cast.visitors.overflow);
      for (const sub of state.subagents) {
        const kind = visitorKind(cast.visitors, sub.type);
        const seat = seating.seated.get(sub.id);
        const waitingIndex = seating.waiting.indexOf(sub.id);
        const spot = seat !== undefined ? spotAt(cast.visitors.spots[seat]) : undefined;
        if (spot) wanted.set(`visitor:${sub.id}`, { kind, at: spot.at, facing: spot.facing ?? 0, task: sub.task ?? "", walker });
        else if (overflow && waitingIndex >= 0 && waitingIndex < MAX_WAITING_DRAWN)
          wanted.set(`visitor:${sub.id}`, { kind, at: waitingPosition(overflow, waitingIndex, home.room.size), facing: overflow.facing ?? 0, task: sub.task ?? "", walker });
      }
    }
    // Tomo and the pet: a rule's spot, a wander spot, or their own (wander.ts).
    const mover = (key: "tomo" | "pet", who: NonNullable<typeof cast.tomo>) => {
      const existing = this.characters.get(key);
      const walker = walkerOf(key, home), speed = who.walk?.speed ?? WALK_SPEED_DEFAULT;
      let stroll: WalkPlan | undefined;
      const placing = placeCharacter(who, state.conditions, existing?.wander ?? null, now, this.random, {
        tomo: key === "tomo", reduced: this.reducedMotion, at: existing?.spot,
        allowed: (from, to) => this.canWander(key, walker, from, to, wanted),
        // The stroll there, planned now: it stays once it has arrived.
        travel: (_from, to) => {
          const target = spots[to];
          if (!existing || !target) return 0;
          const here = this.pose(existing, now);
          stroll = planMove(this.grid(walker), here.position, target.at, here.yaw, (target.facing ?? 0) * RAD, { speed, maxDuration: Infinity, fade: here.fade, bob: here.bob });
          return stroll.duration;
        },
      });
      const spot = spotAt(placing.spot) ?? spotAt(who.spot);
      if (spot) wanted.set(key, { kind: who.kind, at: spot.at, facing: spot.facing ?? 0, task: "", walker, spot: placing.spot, by: placing.by, wander: placing.wander, speed, plan: stroll });
    };
    if (cast.tomo) mover("tomo", cast.tomo);
    if (cast.pet && state.hasPet) mover("pet", cast.pet);

    for (const [key, character] of this.characters) if (!wanted.has(key) && !character.leaving) { character.leaving = true; character.wander = null; if (immediate) character.appear = 0; }
    for (const [key, want] of wanted) {
      let character = this.characters.get(key);
      const to: Vec3 = [...want.at], yaw = want.facing * RAD;
      if (character && character.kind !== want.kind) { this.dropCharacter(character); character = undefined; }
      if (!character) {
        character = { key, kind: want.kind, anchor: new Group(), body: null, walker: want.walker, to, toYaw: yaw, plan: null, start: now,
          spot: want.spot, by: want.by, wander: want.wander ?? null, appear: immediate ? 1 : 0, leaving: false, task: want.task };
        const node = layoutKind(home, want.kind, key);
        if (node) {
          character.body = buildNodes([node], this.resources!);
          character.anchor.add(character.body.root);
          for (const part of character.body.parts) retarget(part, partEffects(part.node.reactions, state.conditions));
        }
        character.anchor.position.set(...to); character.anchor.rotation.y = yaw;
        this.world!.add(character.anchor);
        this.characters.set(key, character);
        continue;
      }
      character.leaving = false; character.task = want.task;
      // A rule taking over a stroll goes at once, at a rule's pace, even to the same spot.
      const hurried = want.by !== undefined && want.by !== "wander" && character.by === "wander" && character.plan !== null;
      character.spot = want.spot; character.by = want.by; character.wander = want.wander ?? null;
      const [ox, oy, oz] = character.to;
      if (hurried || Math.hypot(ox - to[0], oy - to[1], oz - to[2]) > 0.001 || Math.abs(character.toYaw - yaw) > 0.001) {
        // From wherever it has got to (mid-walk, mid-hop, half faded), round the furniture; reduced motion goes straight there.
        // A stroll goes at the character's own speed, however long it takes; anything else half as fast again, and in a few seconds at most.
        const here = this.pose(character, now);
        const pace = want.by === "wander" ? { speed: want.speed, maxDuration: Infinity } : { speed: want.speed !== undefined ? want.speed * WALK_RULE_FACTOR : undefined };
        const plan = immediate || this.reducedMotion ? null : want.plan ?? planMove(this.grid(character.walker), here.position, to, here.yaw, yaw, { ...pace, fade: here.fade, bob: here.bob });
        character.to = to; character.toYaw = yaw; character.start = now;
        character.plan = plan && plan.duration > 0 ? plan : null;
      }
    }
    this.scheduleWander();
  }

  /**
   * Whether `key` may wander from spot `from` to spot `to`: it can walk
   * there (no fading in and out on a stroll), and no other character is
   * there or heading there.
   */
  private canWander(key: string, walker: WalkerSize, from: string, to: string, wanted: ReadonlyMap<string, { at: Vec3 }>): boolean {
    const spots = this.home?.spots ?? {};
    const a = spots[from]?.at, b = spots[to]?.at;
    if (!a || !b) return false;
    const near = (p: Vec3) => Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]) < 0.05;
    for (const [other, want] of wanted) if (other !== key && near(want.at)) return false;
    for (const [other, character] of this.characters) if (other !== key && !character.leaving && !wanted.has(other) && near(character.to)) return false;
    const cacheKey = `${walker.radius}/${walker.headroom}/${from}/${to}`;
    let ok = this.walkable.get(cacheKey);
    if (ok === undefined) {
      const grid = this.grid(walker);
      ok = !!grid && findRoute(grid, a, b).ok;
      this.walkable.set(cacheKey, ok);
    }
    return ok;
  }

  /** Wakes the stage when the next wander's stay is over (while paused: once it resumes). */
  private scheduleWander(): void {
    if (this.wanderTimer) clearTimeout(this.wanderTimer);
    this.wanderTimer = null;
    if (this.disposed) return;
    let next = Infinity;
    for (const character of this.characters.values()) if (character.wander && !character.leaving) next = Math.min(next, character.wander.leaveAt);
    if (!Number.isFinite(next)) return;
    this.wanderTimer = setTimeout(() => {
      this.wanderTimer = null;
      if (this.paused) { this.wanderDue = true; return; }
      this.wanderNow();
    }, Math.max(0, next - this.now()) * 1000 + 20);
  }
  /** The next step of every wander that is due: from where it is now, nothing missed is played back. */
  private wanderNow(): void {
    this.wanderDue = false;
    if (!this.state || !this.home || !this.built || this.disposed) return;
    this.placeCharacters(this.state, false);
    this.invalidate();
  }

  /** The way round the furniture for a walker of this size, built once per scene (null if the scene defeats it: then it blinks). */
  private grid(walker: WalkerSize): NavGrid | null {
    if (!this.home) return null;
    if (!this.grids.has(walker)) {
      try {
        this.placement ??= placeScene(this.home);
        this.grids.set(walker, buildNavGrid(this.home, { walker, placement: this.placement }));
      } catch { this.grids.set(walker, null); }
    }
    return this.grids.get(walker) ?? null;
  }

  /** Where a character is at `now`: along its move, or standing at its spot. */
  private pose(character: Character, now: number): WalkPose {
    return character.plan ? poseAt(character.plan, now - character.start) : { position: [...character.to], bob: 0, yaw: character.toYaw, fade: 1 };
  }

  private dropCharacter(character: Character): void {
    this.world?.remove(character.anchor);
    this.characters.delete(character.key);
  }

  /** One frame of a character: walking its way round the furniture (walk.ts), turning, appearing or leaving. */
  private stepCharacter(character: Character, now: number, dt: number): boolean {
    const reduced = this.reducedMotion;
    let busy = false;
    const goal = character.leaving ? 0 : 1;
    character.appear = reduced ? goal : character.appear + Math.sign(goal - character.appear) * Math.min(Math.abs(goal - character.appear), dt * 4);
    if (character.appear !== goal) busy = true;
    if (character.leaving && character.appear === 0) { this.dropCharacter(character); return false; }
    // Reduced motion (even switched on mid-walk) is there at once.
    if (character.plan && (reduced || now - character.start >= character.plan.duration)) character.plan = null;
    if (character.plan) busy = true;
    const pose = this.pose(character, now);
    const s = smooth(Math.min(1, character.appear)) * pose.fade;
    character.anchor.scale.set(0.6 + 0.4 * s, s, 0.6 + 0.4 * s);
    character.anchor.visible = s > 0.01;
    character.anchor.position.set(pose.position[0], pose.position[1] + pose.bob, pose.position[2]);
    character.anchor.rotation.y = pose.yaw;
    return busy;
  }

  private allParts() { return [...(this.built?.parts ?? []), ...[...this.characters.values()].flatMap((c) => c.body?.parts ?? [])]; }
  private allSigns() { return [...(this.built?.signs ?? []), ...[...this.characters.values()].flatMap((c) => c.body?.signs ?? [])]; }
  private now() { return performance.now() / 1000; }

  /** Night and heavy weather dim the scene's light and cool it, a little. */
  private applySky(): void {
    const sky = this.state?.sky;
    const { factor, tint, tintAmount } = sky ? skyLight(sky) : { factor: 1, tint: "#ffffff", tintAmount: 0 };
    this.hemi.intensity = this.light.hemi * (0.35 + 0.65 * factor);
    this.sun.intensity = this.light.sun * factor;
    this.sun.color.copy(this.light.color).lerp(new Color(tint), tintAmount);
    this.hemi.color.set("#fff4e0").lerp(new Color(tint), tintAmount * 0.8);
  }
  /** Redraws the windows' sky: when it changed, and at ~15 fps while its weather moves (never with reduced motion). */
  private drawWindows(now: number, changed = false): boolean {
    const windows = this.built?.windows ?? [];
    const sky = this.state?.sky;
    if (!windows.length || !sky) return false;
    const moving = skyMoves(sky) && !this.reducedMotion;
    if (changed || (moving && now - this.skyDrawnAt >= 1 / 15)) {
      this.skyDrawnAt = now;
      const t = moving ? now : 0;
      for (const window of windows) {
        const context = window.canvas.getContext("2d");
        if (context) { drawSky(context, window.canvas.width, window.canvas.height, sky, t); window.texture.needsUpdate = true; }
      }
    }
    return moving;
  }

  /** The first glowing parts light their surroundings a little (a lamp warms the desk). */
  private placeGlowLights(): void {
    const glowing = this.allParts().filter((part) => part.weights.glow > 0 && part.motion.visible).slice(0, GLOW_LIGHTS);
    const centre = new Vector3();
    this.glowLights.forEach((light, i) => {
      const part = glowing[i];
      if (!part) { light.intensity = 0; return; }
      const { min, max } = part.node.box;
      // The box is in the motion frame, its scale already applied.
      part.motion.localToWorld(centre.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2 + 0.05));
      light.position.copy(centre);
      light.color.copy(part.last.glow ?? part.meshes[0]?.base ?? new Color("#ffffff"));
      light.intensity = part.weights.glow * 1.4;
    });
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.fit();
    this.invalidate();
  }

  /**
   * The default view: far enough that the whole room fits from every angle
   * between AZIMUTH_MIN and AZIMUTH_MAX. Then the owner's limits around it;
   * a view the owner moved is kept (clamped to them), else it is the default.
   */
  private fit(): void {
    if (!this.home) return;
    const [w, h, d] = this.size;
    this.elevation = elevationFor(this.width / this.height);
    const kept = { position: this.camera.position.clone(), target: this.controls.target.clone() };
    const corners: Vector3[] = [];
    for (let i = 0; i < 8; i++) corners.push(new Vector3(i & 1 ? w / 2 + 0.1 : -w / 2 - 0.2, i & 2 ? h : -0.2, i & 4 ? d / 2 + 0.1 : -d / 2 - 0.2));
    let distance = 4;
    for (const azimuth of [AZIMUTH_MIN, AZIMUTH_DEFAULT, AZIMUTH_MAX, (AZIMUTH_MIN + AZIMUTH_DEFAULT) / 2, (AZIMUTH_DEFAULT + AZIMUTH_MAX) / 2]) {
      let low = 2, high = 120;
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        this.place(this.center, azimuth, this.elevation, mid);
        const fits = corners.every((corner) => { const p = corner.clone().project(this.camera); return Math.abs(p.x) < 0.97 && Math.abs(p.y) < 0.94 && p.z < 1; });
        if (fits) high = mid; else low = mid;
      }
      distance = Math.max(distance, high);
    }
    this.distance = distance;
    Object.assign(this.controls, viewLimits(this.size, distance));
    this.controls.cursor.copy(this.center);
    if (!this.moved) { this.resetView(); return; }
    this.camera.position.copy(kept.position); this.controls.target.copy(kept.target);
    this.settle();
  }
  private place(target: Vector3, azimuth: number, elevation: number, distance: number): void {
    const flat = Math.cos(elevation) * distance;
    this.camera.position.set(target.x + Math.sin(azimuth) * flat, target.y + Math.sin(elevation) * distance, target.z + Math.cos(azimuth) * flat);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }
  /** Apply the controls' limits now, dropping any motion still gliding. */
  private settle(): void {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
  }

  /** The owner has moved the view from the default. */
  isMoved(): boolean { return this.moved; }

  /** The view as it is now. */
  view(): StageView {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new Spherical().setFromVector3(offset);
    const t = this.controls.target;
    return { distance: spherical.radius, azimuth: MathUtils.euclideanModulo(spherical.theta, Math.PI * 2), elevation: Math.PI / 2 - spherical.phi, target: [t.x, t.y, t.z] };
  }
  private tellView(): void { try { this.onView?.(this.view()); } catch { /* a listener never breaks the drawing */ } }

  /** Orbit by `azimuth` radians round the room and `elevation` up (the keyboard's way), within the limits. */
  turn(azimuth: number, elevation = 0): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new Spherical().setFromVector3(offset);
    spherical.theta += azimuth;
    spherical.phi = MathUtils.clamp(spherical.phi - elevation, this.controls.minPolarAngle, this.controls.maxPolarAngle);
    this.camera.position.copy(this.controls.target).add(offset.setFromSpherical(spherical));
    this.moved = true;
    this.settle();
    this.fastUntil = performance.now() / 1000 + 0.5;
    this.invalidate();
  }
  /** Zoom by `factor` (below 1 closer), within the limits. */
  zoom(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(offset);
    this.moved = true;
    this.settle();
    this.invalidate();
  }
  /** Back to the default view. */
  resetView(): void {
    this.settle();
    this.controls.target.copy(this.center);
    this.place(this.center, AZIMUTH_DEFAULT, this.elevation, this.distance);
    this.moved = false;
    this.settle();
    this.invalidate();
    this.tellView();
  }

  /** Something changed: draw again (and keep drawing while anything moves). */
  invalidate(): void {
    if (this.frame || this.paused || this.disposed) return;
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }
  private tick(time: number): void {
    this.frame = 0;
    if (this.paused || this.disposed) return;
    const now = time / 1000;
    // Ambient motion (a bob, a breath) is drawn at 30 fps; walking, appearing and turning the view at full rate.
    if (this.lastTime && !this.fast && now >= this.fastUntil && now - this.lastTime < 1 / 30 - 0.004) { this.invalidate(); return; }
    const dt = this.lastTime ? Math.min(0.1, Math.max(0, now - this.lastTime)) : 1 / 60;
    this.lastTime = now;
    let busy = false;
    for (const part of this.allParts()) if (stepPart(part, dt, now, this.reducedMotion)) busy = true;
    let moving = false;
    for (const character of [...this.characters.values()]) if (this.stepCharacter(character, performance.now() / 1000, dt)) moving = true;
    this.fast = moving;
    if (this.drawWindows(now)) busy = true;
    this.placeGlowLights();
    // Gliding to a stop after the owner lets go (damping).
    const gliding = this.controls.enableDamping && this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (gliding) this.fastUntil = now + 0.1;
    if (busy || moving || gliding) this.invalidate(); else this.lastTime = 0;
  }

  pause(): void { this.paused = true; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.lastTime = 0; }
  resume(): void { if (!this.paused) return; this.paused = false; if (this.wanderDue) this.wanderNow(); this.invalidate(); }

  /**
   * A picture of the room as it is now, as base64 PNG no larger than
   * `maxBytes` decoded: rendered, copied in the same task (the drawing
   * buffer is not kept), then scaled down until it fits.
   */
  capture(maxBytes: number, longest = 1600): string | null {
    if (!this.home || this.disposed) return null;
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const copy = document.createElement("canvas");
    copy.width = source.width; copy.height = source.height;
    const context = copy.getContext("2d");
    if (!context || !copy.width || !copy.height) return null;
    context.drawImage(source, 0, 0);
    let scale = Math.min(1, longest / Math.max(copy.width, copy.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(copy.width * scale)); out.height = Math.max(1, Math.round(copy.height * scale));
      out.getContext("2d")?.drawImage(copy, 0, 0, out.width, out.height);
      const url = out.toDataURL("image/png");
      const base64 = url.slice(url.indexOf(",") + 1);
      if (base64Bytes(base64) <= maxBytes) return base64;
      scale *= 0.7;
    }
    return null;
  }

  private clearWorld(): void {
    if (this.world) this.scene.remove(this.world);
    this.characters.clear();
    this.seats = new Map();
    if (this.wanderTimer) clearTimeout(this.wanderTimer);
    this.wanderTimer = null; this.wanderDue = false;
    this.resources?.dispose();
    this.resources = null; this.world = null; this.built = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.clearWorld();
    this.sun.shadow.map?.dispose();
    this.sun.dispose(); this.hemi.dispose(); for (const light of this.glowLights) light.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
