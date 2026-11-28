import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { watchBus, type WatchBus } from "../watch/bus.js";
import { log } from "../logger.js";
import { homeSnapshotSchema, WebError, type WebEvent, type WebHome } from "../web/protocol.js";
import { decodeSnapshotPng } from "./snapshot.js";
import { HomeSceneStore, type HomeView } from "./store.js";
import { HomeStatusReducer, type HomeSubsession } from "./status-reducer.js";
import type { HomeStatus } from "./status.js";
import { HomeWeatherSource, type FetchLike } from "./weather.js";

/**
 * Tomo's home, daemon side: the scene store, the status reducer fed by the
 * watch bus, and the "look" broker that asks an open Home page for a
 * picture. The web channel serves `web()` and forwards snapshots here; the
 * home_check tool reads `store` and calls `look()`.
 *
 * Web events: `home` when the store's revision changes, `home-status` when
 * the status record changes (at most every STATUS_MIN_INTERVAL_MS, the last
 * change always delivered), `home-look` when Tomo asks to see the room.
 */

/** home-status is published at most this often (4 a second). */
export const STATUS_MIN_INTERVAL_MS = 250;
/** Expiries (stale turns, trouble timeouts, a rate limit's reset) are re-checked this often. */
export const STATUS_TICK_MS = 15_000;
/** The next scheduled job and the pet's mood are re-read this often (and on each cron event). */
export const OUTSIDE_REFRESH_MS = 60_000;
/**
 * A turn's end is published before the daemon stops counting the turn as in
 * flight, and "is this sub-session at work" reads that count: the status is
 * read once more this long after a turn ends.
 */
export const TURN_END_RECHECK_MS = 300;
/** How long home_check waits for an open Home page to send its picture. */
export const LOOK_TIMEOUT_MS = 6_000;
const MAX_PENDING_LOOKS = 4;
/**
 * "Is anyone looking?": an open Home page re-reads GET /home at least every
 * 60 s, so a read within this long means a page is showing. Separate from the
 * weather's own two-hour "wanted" window (weather.ts).
 */
export const PRESENCE_MS = 90_000;
/** A picture sent without being asked counts as "now" for this long. */
export const UNASKED_SNAPSHOT_FRESH_MS = 10_000;

export interface HomeSnapshot { png: Buffer; revision: string; at: number; requestId?: string }
export type LookResult =
  | { status: "picture"; snapshot: HomeSnapshot }
  | { status: "no_browser" }
  | { status: "no_answer" };

export interface HomeServiceOptions {
  workspaceDir: string;
  lastGoodPath: string;
  bus?: WatchBus;
  now?: () => number;
  /** When the next enabled scheduled job runs (ms epoch), if any; must not throw. */
  nextJobAt?: () => number | undefined;
  /** The pet's mood word, if Tomo has a pet; must not throw. */
  petMood?: () => string | undefined;
  /** The owner's running sub-sessions, as the browser may already see them (titles only); a throw seats nobody. */
  subsessions?: () => readonly HomeSubsession[];
  /** The configured city (`config.city`): what the window shows. No city, no weather request. */
  city?: string | null;
  /** Weather fetch (tests). */
  weatherFetch?: FetchLike;
  /** Store timings (tests). */
  debounceMs?: number;
  pollMs?: number;
}

/** What the home needs from the web UI; absent while the UI is not configured. */
export interface HomeWebLink {
  publish(event: WebEvent): void;
  /** The web process is up (supervisor state "running"). */
  available(): boolean;
  /** May the browser already read this session's task text (the Tasks panel's rule)? */
  mayShowTask(sessionKey: string): boolean;
}

export class HomeService {
  readonly store: HomeSceneStore;
  readonly weather: HomeWeatherSource;
  private readonly reducer: HomeStatusReducer;
  private readonly now: () => number;
  private readonly bus: WatchBus;
  private link: HomeWebLink | undefined;
  private unsubscribe: (() => void) | undefined;
  private unwatchStore: (() => void) | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private throttle: ReturnType<typeof setTimeout> | undefined;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private lastPublishedAt = 0;
  private published: Partial<HomeStatus> | undefined;
  private outsideAt = 0;
  private pending = new Map<string, { resolve(snapshot: HomeSnapshot | undefined): void; timer: ReturnType<typeof setTimeout> }>();
  private latest: HomeSnapshot | undefined;
  private viewedAt = -Infinity;

  constructor(private readonly options: HomeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.bus = options.bus ?? watchBus;
    this.store = new HomeSceneStore({ workspaceDir: options.workspaceDir, lastGoodPath: options.lastGoodPath,
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}), ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}) });
    this.reducer = new HomeStatusReducer(this.now());
    this.weather = new HomeWeatherSource(options.city, { now: this.now, onUpdate: () => this.changed(),
      ...(options.weatherFetch ? { fetch: options.weatherFetch } : {}) });
  }

  start(): void {
    this.store.start();
    this.unwatchStore = this.store.onChange((view) => this.emit({ type: "home", revision: view.revision }));
    this.refreshOutside(true);
    this.unsubscribe = this.bus.subscribe((event) => {
      try {
        this.reducer.apply(event);
        if (event.type === "cron.fired" || event.type === "cron.done") this.refreshOutside(true);
        this.changed();
        if (this.options.subsessions && (event.type === "turn.end" || event.type === "turn.requeue")) this.recheckSoon();
      } catch (error) { log.debug({ err: error }, "Home status: event not applied"); }
    });
    this.tick = setInterval(() => { this.refreshOutside(false); this.changed(); }, STATUS_TICK_MS);
    this.tick.unref?.();
  }
  stop(): void {
    this.unsubscribe?.();
    this.unwatchStore?.();
    clearInterval(this.tick);
    clearTimeout(this.throttle);
    clearTimeout(this.recheck);
    this.store.stop();
    for (const [id, look] of this.pending) { clearTimeout(look.timer); look.resolve(undefined); this.pending.delete(id); }
  }

  /** Connects the web UI: events go out through `link.publish`. */
  attachWeb(link: HomeWebLink): void { this.link = link; }
  /** Something the status reads from outside the bus changed (the sub-session table): publish if it shows. */
  refresh(): void { this.changed(); }

  /**
   * The status record. `sky` comes from the weather source: its progress is
   * rounded to hundredths, so moving along is a change at most every few
   * minutes, while a new phase or weather is one at once.
   */
  status(): HomeStatus {
    const status = this.reducer.status(this.now(), {
      mayShowTask: (key) => this.link?.mayShowTask(key) ?? false,
      // Like task text: nothing of a sub-session before a web UI is attached to show it.
      ...(this.link && this.options.subsessions ? { subsessions: this.options.subsessions } : {}),
    });
    const sky = this.weather.sky();
    return sky ? { ...status, sky } : status;
  }
  /** The home for a page: reading it means someone is looking, so the sky is kept fresh. */
  web(): WebHome {
    this.viewedAt = this.now();
    this.weather.want();
    const view: HomeView = this.store.view();
    return { scene: view.scene, revision: view.revision, starter: view.starter, ...(view.problems ? { problems: view.problems } : {}), status: this.status() };
  }

  /** One more read shortly after a turn ends (TURN_END_RECHECK_MS); the latest end restarts the wait. */
  private recheckSoon(): void {
    clearTimeout(this.recheck);
    this.recheck = setTimeout(() => { this.recheck = undefined; this.changed(); }, TURN_END_RECHECK_MS);
    this.recheck.unref?.();
  }
  private emit(event: WebEvent): void {
    try { this.link?.publish(event); } catch { /* an oversized or closed outlet never fails the daemon */ }
  }
  private refreshOutside(force: boolean): void {
    const now = this.now();
    if (!force && now - this.outsideAt < OUTSIDE_REFRESH_MS) return;
    this.outsideAt = now;
    try { this.reducer.setNextJobAt(this.options.nextJobAt?.()); } catch { this.reducer.setNextJobAt(undefined); }
    try { this.reducer.setPet(this.options.petMood?.()); } catch { this.reducer.setPet(undefined); }
  }
  /** Publishes the status if it changed, no more often than STATUS_MIN_INTERVAL_MS; the latest change always goes out. */
  private changed(): void {
    if (!this.link || this.throttle) return;
    const wait = this.lastPublishedAt + STATUS_MIN_INTERVAL_MS - this.now();
    if (wait > 0) {
      this.throttle = setTimeout(() => { this.throttle = undefined; this.changed(); }, wait);
      this.throttle.unref?.();
      return;
    }
    const status = this.status();
    const record: Partial<HomeStatus> = { ...status };
    delete record.at;
    if (this.published && isDeepStrictEqual(this.published, record)) return;
    this.published = record;
    this.lastPublishedAt = this.now();
    this.emit({ type: "home-status", status });
  }

  /**
   * Asks an open Home page for a picture of the room and waits for it (at
   * most `timeoutMs`). With the web UI not running, or no read of /home in
   * the last PRESENCE_MS, there is nobody to ask and it answers at once.
   * A picture sent unasked within the last few seconds of the same revision
   * is used if nothing answers.
   */
  async look(revision: string, timeoutMs = LOOK_TIMEOUT_MS): Promise<LookResult> {
    // Nobody has read /home lately: no page is showing, so ask nobody and wait for nothing.
    if (!this.link || !this.link.available() || this.now() - this.viewedAt > PRESENCE_MS) return { status: "no_browser" };
    this.weather.want();
    if (this.pending.size >= MAX_PENDING_LOOKS) return { status: "no_answer" };
    const requestId = randomUUID();
    const answer = new Promise<HomeSnapshot | undefined>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(undefined); }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
    });
    this.emit({ type: "home-look", requestId });
    const snapshot = await answer;
    if (snapshot) return { status: "picture", snapshot };
    const recent = this.latest;
    if (recent && !recent.requestId && recent.revision === revision && this.now() - recent.at <= UNASKED_SNAPSHOT_FRESH_MS) return { status: "picture", snapshot: recent };
    return { status: "no_browser" };
  }

  /**
   * A picture from the page (POST /home/snapshot, re-checked here: the web
   * process is not trusted to have done it). Kept as the latest; answers
   * the look it names, if one is waiting.
   */
  deliverSnapshot(input: unknown): { accepted: boolean } {
    const parsed = homeSnapshotSchema.safeParse(input);
    if (!parsed.success) throw new WebError(400, "invalid_snapshot");
    const png = decodeSnapshotPng(parsed.data.png);
    const snapshot: HomeSnapshot = { png, revision: parsed.data.revision, at: this.now(), ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}) };
    this.latest = snapshot;
    const look = parsed.data.requestId ? this.pending.get(parsed.data.requestId) : undefined;
    if (look) {
      this.pending.delete(parsed.data.requestId!);
      clearTimeout(look.timer);
      look.resolve(snapshot);
    }
    return { accepted: true };
  }
  /** The last picture any page sent, if any. */
  latestSnapshot(): HomeSnapshot | undefined { return this.latest; }
}

// The one running service, for the tomo-internal home_check tool (created per
// live session, with no other way to reach daemon services). Like watchBus.
let running: HomeService | undefined;
export function setHomeService(service: HomeService | undefined): void { running = service; }
export function homeService(): HomeService | undefined { return running; }
