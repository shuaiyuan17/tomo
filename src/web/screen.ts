import { execFile } from "node:child_process";

/** Frame rates a viewer may ask for (frames per second). */
export const SCREEN_RATES = [0.5, 1, 2] as const;
export type ScreenRate = typeof SCREEN_RATES[number];
/** A frame larger than this is not sent (the browser would only fall further behind). */
export const MAX_FRAME_BYTES = 1536 * 1024;
/** Longest edge of a sent frame, and its JPEG quality (sips' 0–100 scale). */
export const FRAME_MAX_EDGE = 1600;
export const FRAME_QUALITY = 60;

/**
 * What the browser is told with every tick. `live` carries a JPEG; the others
 * say why there is no current picture, so a stale or wallpaper-only image is
 * never presented as the live screen. `unconfirmed` means the lock state
 * could not be established (the check failed, timed out or was incomplete):
 * nothing is captured then — fail closed.
 */
export type ScreenStatus = "live" | "locked" | "away" | "unconfirmed" | "unavailable" | "too_large";
export interface ScreenFrame { status: ScreenStatus; capturedAt: number; jpeg?: Buffer }

/** Whether this session's screen may be captured right now. */
export type ConsoleState = "unlocked" | "locked" | "away" | "unknown";
/** One look at the screen: the lock state, and a JPEG only when it was unlocked. */
export interface ScreenShot { state: ConsoleState; jpeg?: Buffer }
export interface ScreenSource {
  /** Check the lock state and, only if unlocked, capture the main display (downscaled JPEG, in memory). */
  shoot(): Promise<ScreenShot>;
}

type Viewer = { rate: ScreenRate; send: (frame: ScreenFrame) => void };

/**
 * One capture loop shared by every viewer. It runs only while at least one
 * viewer is subscribed, at the fastest rate any of them asked for, with at
 * most one capture in flight; the last viewer leaving stops it outright, and
 * a capture that returns after everyone left is discarded.
 */
export class ScreenLoop {
  private viewers = new Set<Viewer>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private readonly now: () => number;

  constructor(private readonly source: ScreenSource, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get viewerCount(): number { return this.viewers.size; }
  get running(): boolean { return this.timer !== undefined || this.inFlight; }

  subscribe(rate: ScreenRate, send: Viewer["send"]): () => void {
    const viewer: Viewer = { rate, send };
    this.viewers.add(viewer);
    // A new viewer gets a frame now rather than waiting out someone else's interval.
    if (!this.inFlight) { clearTimeout(this.timer); this.timer = undefined; void this.tick(); }
    return () => {
      this.viewers.delete(viewer);
      if (!this.viewers.size) { clearTimeout(this.timer); this.timer = undefined; }
    };
  }

  private interval(): number {
    return 1000 / Math.max(...[...this.viewers].map((v) => v.rate));
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (!this.viewers.size || this.inFlight) return;
    this.inFlight = true;
    let frame: ScreenFrame;
    try {
      const shot = await this.source.shoot();
      const at = this.now();
      if (shot.state === "locked" || shot.state === "away") frame = { status: shot.state, capturedAt: at };
      else if (shot.state !== "unlocked") frame = { status: "unconfirmed", capturedAt: at };
      else if (!shot.jpeg?.length) frame = { status: "unavailable", capturedAt: at };
      else frame = shot.jpeg.length > MAX_FRAME_BYTES ? { status: "too_large", capturedAt: at } : { status: "live", capturedAt: at, jpeg: shot.jpeg };
    } catch (error) {
      frame = { status: error instanceof UnconfirmedScreenError ? "unconfirmed" : "unavailable", capturedAt: this.now() };
    } finally { this.inFlight = false; }
    // Everyone left while this capture ran: drop it and stay stopped.
    if (!this.viewers.size) return;
    for (const viewer of [...this.viewers]) {
      try { viewer.send(frame); } catch { /* One slow or closed viewer never stops the others. */ }
    }
    if (this.viewers.size && !this.timer) {
      this.timer = setTimeout(() => void this.tick(), this.interval());
      this.timer.unref?.();
    }
  }
}

/** The lock state could not be established; nothing was captured. */
export class UnconfirmedScreenError extends Error {}

/**
 * The lock state of THIS process's own login session, from
 * `CGSessionCopyCurrentDictionary`. Using our own session (not the first
 * entry of a list of sessions) means another user's session can never be
 * mistaken for ours. Fail closed: anything incomplete is `unknown`.
 * macOS reports an unlocked session by leaving `CGSSessionScreenIsLocked`
 * out, so its absence counts as unlocked only when the session is otherwise
 * complete (on console, login done).
 */
export function consoleStateFromSession(session: unknown): ConsoleState {
  if (!session || typeof session !== "object" || Array.isArray(session)) return "unknown";
  const s = session as Record<string, unknown>;
  if (s.CGSSessionScreenIsLocked === true || s.CGSSessionScreenIsLocked === 1) return "locked";
  if (s.kCGSSessionOnConsoleKey === false || s.kCGSSessionOnConsoleKey === 0) return "away";
  if (s.kCGSSessionOnConsoleKey !== true || s.kCGSessionLoginDoneKey !== true) return "unknown";
  if (s.CGSSessionScreenIsLocked !== undefined && s.CGSSessionScreenIsLocked !== false && s.CGSSessionScreenIsLocked !== 0) return "unknown";
  return "unlocked";
}

/**
 * JXA (osascript's JavaScript, part of macOS: no compiler, no Xcode) that
 * reads this session's lock state and, only when it is unlocked, captures
 * the main display with CGDisplayCreateImage, scales it to FRAME_MAX_EDGE
 * and encodes JPEG at FRAME_QUALITY in memory. It prints one JSON line to
 * stdout; nothing is written to disk.
 */
export const CAPTURE_SCRIPT = `
ObjC.import("AppKit"); ObjC.import("CoreGraphics");
function run() {
  const ref = $.CGSessionCopyCurrentDictionary();
  const session = ref ? ObjC.deepUnwrap(ObjC.castRefToObject(ref)) : null;
  const out = { session: session };
  if (!session || session.CGSSessionScreenIsLocked || session.kCGSSessionOnConsoleKey !== true || session.kCGSessionLoginDoneKey !== true) return JSON.stringify(out);
  const image = $.CGDisplayCreateImage($.CGMainDisplayID());
  if (!image || (image.isNil && image.isNil())) return JSON.stringify(out);
  const w = $.CGImageGetWidth(image), h = $.CGImageGetHeight(image);
  const scale = Math.min(1, ${FRAME_MAX_EDGE} / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
  const source = $.NSBitmapImageRep.alloc.initWithCGImage(image);
  const target = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, nw, nh, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(target));
  source.drawInRectFromRectOperationFractionRespectFlippedHints($.NSMakeRect(0, 0, nw, nh), $.NSZeroRect, $.NSCompositingOperationCopy, 1, false, $());
  $.NSGraphicsContext.restoreGraphicsState;
  const data = target.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, $({ NSImageCompressionFactor: ${FRAME_QUALITY / 100} }));
  out.jpeg = data.base64EncodedStringWithOptions(0).js;
  return JSON.stringify(out);
}`;

/** Parse the helper's output. A missing or malformed session is unknown (fail closed). */
export function parseShot(stdout: string): ScreenShot {
  let value: { session?: unknown; jpeg?: unknown };
  try { value = JSON.parse(stdout) as typeof value; } catch { throw new UnconfirmedScreenError("unreadable helper output"); }
  const state = consoleStateFromSession(value.session);
  if (state !== "unlocked") return { state };
  if (typeof value.jpeg !== "string" || !/^[A-Za-z0-9+/=]+$/.test(value.jpeg)) return { state };
  return { state, jpeg: Buffer.from(value.jpeg, "base64") };
}

/**
 * The real source on macOS: one `osascript -l JavaScript` run per frame,
 * bounded in time (a hung helper is killed and reads as unconfirmed) and in
 * output size. The picture exists only in the helper's memory, its stdout
 * pipe and this process's memory — never in a file.
 *
 * Limitation: without Screen Recording permission macOS still returns an
 * image, showing only the desktop picture; that cannot be told apart cheaply
 * here, so the browser says so next to every frame.
 */
export function macScreenSource(options: { timeoutMs?: number; osascript?: string } = {}): ScreenSource {
  return {
    shoot: () => new Promise((resolve, reject) => {
      execFile(options.osascript ?? "/usr/bin/osascript", ["-l", "JavaScript", "-e", CAPTURE_SCRIPT],
        { timeout: options.timeoutMs ?? 5_000, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" }, (error, stdout) => {
          if (error) { reject(new UnconfirmedScreenError("screen helper failed")); return; }
          try { resolve(parseShot(stdout)); } catch (err) { reject(err); }
        });
    }),
  };
}
