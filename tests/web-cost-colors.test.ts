import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Study · Cost chart tokens (`.viz` / `.dark .viz` in styles.css). Pins the dark palette's
 * dataviz checks (the same math as the dataviz skill's validate_palette.js: OKLCH band and chroma
 * floor, Machado 2009 CVD ΔE, normal-vision ΔE, WCAG contrast) so a later tweak cannot quietly
 * push the dark charts back to glaring, or blur two series together.
 */
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
function tokens(selector: string): Record<string, string> {
  const body = new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!body) throw new Error(`no ${selector} block`);
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(([, k, v]) => [k, v.toLowerCase()]));
}
const light = tokens(".viz");
const dark = tokens(".dark .viz");
const DARK_CARD = /\.dark\s*\{[^}]*--card:\s*(#[0-9a-f]{6})/i.exec(css)![1];

const lin = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
function oklab([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const L = (h: string) => oklab(lin(h))[0];
const C = (h: string) => { const [, a, b] = oklab(lin(h)); return Math.hypot(a, b); };
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const sim = (h: string, kind?: keyof typeof MACHADO) => kind ? MACHADO[kind].map((row) => Math.max(0, Math.min(1, row.reduce((sum, k, i) => sum + k * lin(h)[i], 0)))) : lin(h);
const deltaE = (a: string, b: string, kind?: keyof typeof MACHADO) => { const [p, q] = [oklab(sim(a, kind)), oklab(sim(b, kind))]; return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

const SERIES = ["series-1", "series-2", "series-3"];
const RAMP = ["seq-0", "seq-1", "seq-2", "seq-3", "seq-4", "seq-5"];

describe("cost chart tokens", () => {
  it("dark mode has its own value for every chart color, none shared with light", () => {
    for (const key of [...SERIES, ...RAMP]) {
      expect(dark[key], key).toMatch(/^#/);
      expect(dark[key], key).not.toBe(light[key]);
    }
  });

  it("light mode keeps its validated palette", () => {
    expect(SERIES.map((k) => light[k])).toEqual(["#3d7ab5", "#c8623a", "#2f9a74"]);
    expect(RAMP.map((k) => light[k])).toEqual(["#efe8d8", "#cfdcea", "#a3c0dd", "#729fcd", "#3d7ab5", "#27578a"]);
  });

  it("dark series pass the dataviz checks on the card, all pairs (You / Background / Scheduled can all touch)", () => {
    const series = SERIES.map((k) => dark[k]);
    for (const hex of series) {
      expect(L(hex), hex).toBeGreaterThanOrEqual(0.48);
      expect(L(hex), hex).toBeLessThanOrEqual(0.67);
      expect(C(hex), hex).toBeGreaterThanOrEqual(0.10);
      expect(contrast(hex, DARK_CARD), hex).toBeGreaterThanOrEqual(3);
    }
    for (let i = 0; i < series.length; i++) for (let j = i + 1; j < series.length; j++) {
      const [a, b] = [series[i], series[j]];
      expect(deltaE(a, b), `${a}/${b} normal`).toBeGreaterThanOrEqual(15);
      expect(Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan")), `${a}/${b} CVD`).toBeGreaterThanOrEqual(8);
    }
  });

  it("dark series are calmer than before: lower chroma than the old #3987e5/#d95926 (C ≥ 0.16) and below L 0.6", () => {
    for (const key of SERIES) {
      expect(C(dark[key]), key).toBeLessThanOrEqual(0.14);
      expect(L(dark[key]), key).toBeLessThan(0.6);
    }
  });

  it("dark heatmap ramp: brighter means more, every step tells from the next, $0 tells from the card, top stays soft", () => {
    const steps = RAMP.map((k) => L(dark[k]));
    for (let i = 1; i < steps.length; i++) expect(steps[i] - steps[i - 1], RAMP[i]).toBeGreaterThanOrEqual(0.05);
    for (let i = 2; i < steps.length; i++) expect(steps[i] - steps[i - 1], RAMP[i]).toBeGreaterThanOrEqual(0.06);
    expect(L(dark["seq-0"]) - L(DARK_CARD)).toBeGreaterThanOrEqual(0.05);
    expect(contrast(dark["seq-0"], DARK_CARD)).toBeGreaterThanOrEqual(1.2);
    expect(L(dark["seq-5"])).toBeLessThanOrEqual(0.66);
    expect(C(dark["seq-5"])).toBeLessThanOrEqual(0.1);
    expect(contrast(dark["seq-5"], DARK_CARD)).toBeGreaterThanOrEqual(4.5);
  });
});
