import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { OVERLAY_QUERY, PHONE_QUERY } from "../web/src/layers.js";

// The shell's two widths live twice: as Tailwind breakpoints in styles.css (`max-phone:`,
// `max-overlay:`, `min-overlay:`) and as media queries layers.ts hands to matchMedia. They must
// switch at the same pixel. They once did not: Tailwind's `max-[1024px]` is `width < 1024px`, the
// script's `(max-width: 1024px)` included 1024, and at exactly 1024 (and 600) wide each side took
// the other layout.
const styles = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const breakpoint = (name: string) => styles.match(new RegExp(`--breakpoint-${name}:\\s*(\\d+)px;`))?.[1];

/** What the stylesheet emits for a class, through Tailwind itself. */
async function mediaOf(className: string): Promise<string> {
  const theme = styles.match(/--breakpoint-[\w-]+:[^;]+;/g)!.join(" ");
  const css = (await compile(`@theme { ${theme} } @tailwind utilities;`, {})).build([className]);
  return css.match(/@media ([^{]+)\{/)![1].trim();
}

/** Width-only media queries, both spellings Tailwind and layers.ts use. */
function matches(query: string, width: number): boolean {
  let m = query.match(/^\(width < (\d+)px\)$/); if (m) return width < +m[1];
  m = query.match(/^\(width >= (\d+)px\)$/); if (m) return width >= +m[1];
  m = query.match(/^not all and \(min-width: (\d+)px\)$/); if (m) return !(width >= +m[1]);
  throw new Error(`unrecognised query: ${query}`);
}

describe("the shell's breakpoints", () => {
  it("are 600 and 1024 px in the stylesheet", () => {
    expect([breakpoint("phone"), breakpoint("overlay")]).toEqual(["600", "1024"]);
  });

  it.each([
    ["phone", "max-phone:hidden", PHONE_QUERY, 600],
    ["overlay", "max-overlay:hidden", OVERLAY_QUERY, 1024],
  ])("%s: the script and the stylesheet agree on each side of the edge", async (_name, className, query, edge) => {
    const css = await mediaOf(className);
    for (const width of [edge - 1, edge, edge + 1, 390, 820, 1440]) expect([width, matches(query, width)]).toEqual([width, matches(css, width)]);
    expect(matches(query, edge - 1)).toBe(true);
    expect(matches(query, edge)).toBe(false);
  });

  it("`min-overlay:` is exactly the widths `max-overlay:` is not", async () => {
    const css = await mediaOf("min-overlay:hidden");
    for (const width of [1023, 1024, 1025]) expect(matches(css, width)).toBe(!matches(OVERLAY_QUERY, width));
  });

  it("no page spells the two widths as arbitrary values, which would drift from layers.ts again", () => {
    const dir = fileURLToPath(new URL("../web/src/", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.(tsx?|css)$/.test(f));
    const offenders = files.filter((f) => /(max|min)-\[(599|600|601|1023|1024|1025)px\]/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
