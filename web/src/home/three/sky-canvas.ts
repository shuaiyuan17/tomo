import type { Sky } from "../sky.js";

/**
 * The sky in a window, drawn on a 2D canvas in the room's low-poly manner:
 * flat bands of colour, a polygon sun or moon on its arc, polygon clouds,
 * stars at night, and the weather over it (rain streaks, snow flecks, fog
 * bands, a storm's flash). `t` is seconds; a still frame for any fixed `t`.
 */

const BANDS: Record<Sky["phase"], string[]> = {
  night: ["#151b33", "#1b2340", "#232c4f", "#2f3b63"],
  dawn: ["#5f7fae", "#9a9fc0", "#e0aa96", "#f4c08e"],
  day: ["#5f9fd2", "#79b2dc", "#97c6e5", "#bfe0ef"],
  dusk: ["#3e4473", "#7a5d82", "#d0806f", "#eda06a"],
};
const GREY: Record<Sky["phase"], string> = { night: "#2a2e38", dawn: "#8d8f99", day: "#9aa1a8", dusk: "#7d7680" };

function mix(a: string, b: string, amount: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const channel = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - amount) + ((pb >> shift) & 255) * amount);
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}
function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, turn = 0): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) { const a = turn + i * Math.PI * 2 / sides; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  ctx.closePath();
}
/** Deterministic pseudo-random numbers in [0, 1), so stars and drops keep their places. */
function seeded(n: number): number { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

const GREYNESS: Record<Sky["weather"], number> = { clear: 0, clouds: 0.1, overcast: 0.65, fog: 0.5, rain: 0.6, snow: 0.45, storm: 0.8 };
const CLOUDS: Record<Sky["weather"], number> = { clear: 0, clouds: 3, overcast: 6, fog: 0, rain: 5, snow: 4, storm: 6 };

export function drawSky(ctx: CanvasRenderingContext2D, width: number, height: number, sky: Sky, t: number): void {
  const grey = GREYNESS[sky.weather];
  const bands = BANDS[sky.phase];
  bands.forEach((color, i) => { ctx.fillStyle = mix(color, GREY[sky.phase], grey); ctx.fillRect(0, Math.floor(i * height / bands.length), width, Math.ceil(height / bands.length) + 1); });
  const night = sky.phase === "night";
  // Stars, through a clear or broken sky.
  if (night && grey < 0.3) {
    ctx.fillStyle = "#f3efe0";
    for (let i = 0; i < 26; i++) {
      const x = seeded(i) * width, y = seeded(i + 50) * height * 0.75, s = 1 + Math.round(seeded(i + 90) * 1.5) * Math.max(1, height / 160);
      ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(t * 0.7 + i));
      ctx.fillRect(x, y, s, s);
    }
    ctx.globalAlpha = 1;
  }
  // The sun (day, dawn, dusk) or the moon (night) on its arc, by progress.
  const p = sky.progress, r = Math.min(width, height) * 0.11;
  const x = width * (0.12 + 0.76 * p), y = height * (0.9 - Math.sin(Math.PI * p) * 0.68);
  const veiled = grey >= 0.45;
  ctx.globalAlpha = veiled ? 0.35 : 1;
  if (night) {
    ctx.fillStyle = "#f3ead0"; polygon(ctx, x, y, r, 7); ctx.fill();
    ctx.fillStyle = mix(bands[1], GREY.night, grey); polygon(ctx, x + r * 0.45, y - r * 0.2, r * 0.85, 7); ctx.fill();
  } else {
    ctx.fillStyle = sky.phase === "day" ? "#fff1b8" : "#ffd08a"; polygon(ctx, x, y, r * 1.35, 8, Math.PI / 8); ctx.globalAlpha *= 0.35; ctx.fill();
    ctx.globalAlpha = veiled ? 0.35 : 1; ctx.fillStyle = sky.phase === "day" ? "#fff6d0" : "#ffe0a0"; polygon(ctx, x, y, r, 8); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Clouds drift.
  const clouds = CLOUDS[sky.weather];
  const cloudColor = sky.weather === "storm" ? "#4b4f5a" : sky.weather === "rain" ? "#6f757e" : night ? "#3a4260" : sky.weather === "overcast" ? "#c4c8cc" : "#f4f2ec";
  for (let i = 0; i < clouds; i++) {
    const span = width * 1.4, cx = ((seeded(i + 7) * span + t * width * (0.012 + seeded(i + 3) * 0.01)) % span) - width * 0.2;
    const cy = height * (0.12 + seeded(i + 20) * 0.45), s = height * (0.09 + seeded(i + 30) * 0.06);
    ctx.fillStyle = cloudColor; ctx.globalAlpha = 0.92;
    for (const [dx, dy, k] of [[0, 0, 1], [s * 1.1, s * 0.2, 0.8], [-s * 1.0, s * 0.25, 0.75], [s * 0.4, -s * 0.45, 0.7]] as const) { polygon(ctx, cx + dx, cy + dy, s * k, 6, i); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  if (sky.weather === "fog") {
    ctx.fillStyle = night ? "#59607a" : "#e6e6e2";
    for (let i = 0; i < 5; i++) { ctx.globalAlpha = 0.28; const shift = Math.sin(t * 0.15 + i) * width * 0.05; ctx.fillRect(shift - width * 0.1, height * (0.2 + i * 0.16), width * 1.2, height * 0.09); }
    ctx.globalAlpha = 1;
  }
  if (sky.weather === "rain" || sky.weather === "storm") {
    ctx.strokeStyle = night ? "#9fb0d0" : "#e3ecf4"; ctx.lineWidth = Math.max(1, height / 140); ctx.globalAlpha = 0.75;
    const drops = sky.weather === "storm" ? 46 : 32, length = height * 0.07;
    ctx.beginPath();
    for (let i = 0; i < drops; i++) {
      const fall = (seeded(i + 200) + t * (0.9 + seeded(i + 300) * 0.4)) % 1;
      const dx = seeded(i + 100) * width * 1.1, dy = fall * (height + length) - length;
      ctx.moveTo(dx, dy); ctx.lineTo(dx - length * 0.3, dy + length);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (sky.weather === "snow") {
    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < 34; i++) {
      const fall = (seeded(i + 400) + t * (0.08 + seeded(i + 500) * 0.06)) % 1;
      const s = Math.max(2, height / 60) * (0.7 + seeded(i + 600) * 0.6);
      ctx.fillRect(seeded(i + 700) * width + Math.sin(t * 0.8 + i) * width * 0.02, fall * (height + s) - s, s, s);
    }
  }
  // A storm flashes now and then: a brief light and a bolt.
  if (sky.weather === "storm") {
    const beat = Math.floor(t / 3.7), into = t - beat * 3.7;
    if (seeded(beat) < 0.45 && into < 0.18) {
      ctx.fillStyle = "#f7f4ff"; ctx.globalAlpha = 0.55 * (1 - into / 0.18); ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
      const bx = width * (0.2 + seeded(beat + 9) * 0.6);
      ctx.strokeStyle = "#fffbe0"; ctx.lineWidth = Math.max(2, height / 60);
      ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx - width * 0.04, height * 0.3); ctx.lineTo(bx + width * 0.02, height * 0.34); ctx.lineTo(bx - width * 0.05, height * 0.65); ctx.stroke();
    }
  }
}

/** Pixels for a window of `width`×`height` metres. */
export function windowCanvasSize(width: number, height: number): [number, number] {
  let h = 192, w = h * width / height;
  if (w > 512) { h = h * 512 / w; w = 512; }
  return [Math.max(16, Math.round(w)), Math.max(16, Math.round(h))];
}
