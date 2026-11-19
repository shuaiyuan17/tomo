import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(import.meta.dirname, "../web/src/styles.css"), "utf8");
const varValue = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1] ?? "";

describe("web fonts", () => {
  it("self-hosts Source Serif 4 400/600, Latin only, with its OFL licence", () => {
    const faces = css.match(/@font-face\s*{[^}]+}/g) ?? [];
    expect(faces).toHaveLength(2);
    for (const weight of ["400", "600"]) {
      const face = faces.find((f) => f.includes(`font-weight: ${weight}`))!;
      expect(face).toContain(`./fonts/source-serif-4-latin-${weight}-normal.woff2`);
      // CJK never reaches the serif: no range covers U+4E00–9FFF or U+3000–303F / U+FF00–FFEF punctuation.
      const range = /unicode-range:([^;]+);/.exec(face)![1];
      for (const part of range.split(",").map((p) => p.trim())) {
        const [lo, hi = lo] = part.replace("U+", "").split("-").map((h) => parseInt(h, 16));
        for (const cjk of [0x4e00, 0x9fff, 0x3001, 0xff0c]) expect(cjk >= lo && cjk <= hi).toBe(false);
      }
      const file = resolve(import.meta.dirname, `../web/src/fonts/source-serif-4-latin-${weight}-normal.woff2`);
      expect(statSync(file).size).toBeLessThan(32 * 1024);
    }
    expect(readFileSync(resolve(import.meta.dirname, "../web/src/fonts/OFL.txt"), "utf8")).toContain("SIL Open Font License");
    expect(existsSync(resolve(import.meta.dirname, "../web/public/THIRD_PARTY_LICENSES.txt"))).toBe(true);
  });

  it("serif and sans stacks fall back to PingFang SC for Chinese, never to a system serif", () => {
    const serif = varValue("--font-serif");
    expect(serif.startsWith('"Source Serif 4", "PingFang SC"')).toBe(true);
    expect(serif.trim().endsWith("sans-serif")).toBe(true);
    expect(serif).not.toMatch(/Georgia|Times|Songti|(^|,\s*)serif\s*$/);
    expect(varValue("--font-sans")).toContain('"PingFang SC"');
  });

  it("Tomo's replies use the serif reading style; user messages do not", () => {
    const main = readFileSync(resolve(import.meta.dirname, "../web/src/conversation-rows.tsx"), "utf8");
    expect(main).toContain('message.role === "assistant" && "reading"');
    expect(css).toMatch(/\.reading\s*{[^}]*font-serif/);
  });
});
