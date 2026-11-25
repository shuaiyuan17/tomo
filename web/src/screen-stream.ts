import type { WebScreenFrame } from "../../src/web/protocol.js";
import { ApiError } from "./api.js";
import { i18n } from "./i18n/index.js";
import { formatRelative } from "./i18n/format.js";

export const SCREEN_RATES = [0.5, 1, 2] as const;
export type ScreenRate = typeof SCREEN_RATES[number];

/** "Updated 4s ago" / "Updated 2 min ago". */
export function updatedAgo(capturedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - capturedAt) / 1000));
  if (seconds < 2) return i18n.t("common:usage.updatedJustNow");
  // Whole seconds, then whole minutes, then whole hours (Intl.RelativeTimeFormat words them).
  const rounded = seconds < 60 ? seconds * 1000 : seconds < 3600 ? Math.floor(seconds / 60) * 60_000 : Math.floor(seconds / 3600) * 3_600_000;
  return i18n.t("common:usage.updated", { when: formatRelative(-rounded, "narrow") });
}

/** "4s ago" / "2m ago": how old the last picture is (Intl.RelativeTimeFormat). */
export function pictureAge(capturedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - capturedAt) / 1000));
  if (seconds < 2) return i18n.t("screen:justNow");
  const rounded = seconds < 60 ? seconds * 1000 : seconds < 3600 ? Math.floor(seconds / 60) * 60_000 : Math.floor(seconds / 3600) * 3_600_000;
  return formatRelative(-rounded, "narrow");
}

/**
 * Read the screen stream until `signal` aborts. Frames arrive as SSE over
 * fetch (fetch can send the API's custom header; an <img> or EventSource
 * cannot). Closing the stream is what stops the daemon-side capture.
 */
export async function readScreen(rate: ScreenRate, epoch: string, signal: AbortSignal, onFrame: (frame: WebScreenFrame) => void): Promise<void> {
  const response = await fetch(`/api/v1/screen?fps=${rate}&epoch=${encodeURIComponent(epoch)}`, {
    signal, credentials: "same-origin", headers: { "x-tomo-request": "1" }, cache: "no-store",
  });
  if (!response.ok || !response.body) {
    const value = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(response.status, value.error ?? "unavailable");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Stream disconnected");
      buffer += value;
      if (buffer.length > 4 * 1024 * 1024) throw new Error("Stream limit exceeded");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = parseScreenEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame) onFrame(frame);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** One SSE block → a frame, or null for heartbeats and anything malformed. */
export function parseScreenEvent(block: string): WebScreenFrame | null {
  let event = "", data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (event !== "frame" || !data) return null;
  try {
    const value = JSON.parse(data) as WebScreenFrame;
    if (typeof value.capturedAt !== "number" || !["live", "locked", "away", "unconfirmed", "unavailable", "too_large"].includes(value.status)) return null;
    if (value.jpeg !== undefined && (typeof value.jpeg !== "string" || !/^[A-Za-z0-9+/=]+$/.test(value.jpeg))) return null;
    return value;
  } catch { return null; }
}

/** Stream only while the window is open, the page is visible and connected, and the view is not paused. */
export function streamWanted(state: { open: boolean; live: boolean; visible: boolean; paused: boolean; epoch?: string }): boolean {
  return state.open && state.live && state.visible && !state.paused && !!state.epoch;
}

/** Floating window geometry: top-left corner and width; the height follows a 16:10 picture plus the title bar. */
export interface ScreenGeometry { x: number; y: number; width: number }
export interface Viewport { width: number; height: number }
export const TITLE_BAR = 44;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 1280;
/** Distance kept from the viewport edges. */
const MARGIN = 12;
/** Room left free above the bottom edge for the composer. */
const COMPOSER_CLEARANCE = 168;

export function windowHeight(width: number): number { return Math.round(width * 10 / 16) + TITLE_BAR; }

/**
 * The window's CSS `top` and `height`: where and how big it was made, but
 * never past what is visible above the iOS keyboard (`--app-height`,
 * keyboard-viewport.ts): it moves up first, and is cut down (the picture
 * scales inside) only when the visible area is shorter than the window. The
 * stored geometry is left as it was, so it comes back when the keyboard goes.
 */
export function keptAboveKeyboard(top: number, height: number): { top: string; height: string } {
  const visible = "var(--app-height, 100dvh)";
  return { top: `max(0px, min(${top}px, calc(${visible} - ${height}px)))`, height: `min(${height}px, ${visible})` };
}

/** Width / position pulled back inside the viewport (and the size limits). */
export function clampGeometry(geometry: ScreenGeometry, viewport: Viewport): ScreenGeometry {
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport.width - 2 * MARGIN, (viewport.height - 2 * MARGIN - TITLE_BAR) * 16 / 10));
  const width = Math.round(Math.min(Math.max(geometry.width, MIN_WIDTH), maxWidth));
  const height = windowHeight(width);
  const x = Math.round(Math.min(Math.max(geometry.x, MARGIN), Math.max(MARGIN, viewport.width - width - MARGIN)));
  const y = Math.round(Math.min(Math.max(geometry.y, MARGIN), Math.max(MARGIN, viewport.height - height - MARGIN)));
  return { x, y, width };
}

/** Bottom right, about 480 px wide, lifted clear of the composer. */
export function defaultGeometry(viewport: Viewport): ScreenGeometry {
  const width = Math.min(480, viewport.width - 2 * MARGIN);
  return clampGeometry({ x: viewport.width - width - 24, y: viewport.height - windowHeight(width) - COMPOSER_CLEARANCE, width }, viewport);
}

const GEOMETRY_KEY = "tomo-screen-window";
/** Saved geometry, clamped to today's viewport; the default when absent or malformed. */
export function readGeometry(storage: Pick<Storage, "getItem"> | undefined, viewport: Viewport): ScreenGeometry {
  try {
    const value = JSON.parse(storage?.getItem(GEOMETRY_KEY) ?? "null") as Partial<ScreenGeometry> | null;
    if (value && [value.x, value.y, value.width].every((n) => typeof n === "number" && Number.isFinite(n))) return clampGeometry(value as ScreenGeometry, viewport);
  } catch { /* Fall back to the default. */ }
  return defaultGeometry(viewport);
}
export function writeGeometry(storage: Pick<Storage, "setItem"> | undefined, geometry: ScreenGeometry): void {
  try { storage?.setItem(GEOMETRY_KEY, JSON.stringify(geometry)); } catch { /* Storage can be unavailable. */ }
}
