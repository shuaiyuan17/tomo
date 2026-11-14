import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appendedIds } from "../web/src/motion.js";

describe("motion: what counts as appearing", () => {
  it("only ids appended after the known ones animate; older pages loaded above do not", () => {
    const known = new Set(["c", "d"]);
    expect([...appendedIds(known, ["a", "b", "c", "d", "e", "f"])]).toEqual(["e", "f"]);
    expect([...appendedIds(known, ["c", "d"])]).toEqual([]);
    expect([...appendedIds(new Set(), ["x", "y"])]).toEqual(["x", "y"]);
  });
});

describe("motion: the CSS contract", () => {
  const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");

  it("one ease-out token, also the default for every transition", () => {
    const ease = /--ease-soft:\s*([^;]+);/.exec(css)?.[1];
    expect(ease).toMatch(/^cubic-bezier\(/);
    expect(css).toContain(`--default-transition-timing-function: ${ease};`);
    expect(css).toMatch(/--default-transition-duration:\s*120ms;/);
  });

  it("every motion animation is 120–250 ms on the shared curve", () => {
    const rules = [...css.matchAll(/animation:\s*[\w-]+\s+(\d+)ms\s+var\(--ease-soft\)/g)];
    expect(rules.length).toBeGreaterThan(5);
    for (const [, ms] of rules) {
      expect(Number(ms)).toBeGreaterThanOrEqual(120);
      expect(Number(ms)).toBeLessThanOrEqual(250);
    }
    expect(css).not.toMatch(/animation:\s*motion-[\w-]+\s+\d+ms\s+(?!var\(--ease-soft\))/);
  });

  it("reduced motion switches animations and transitions off", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{[^}]*transition: none !important;[^}]*animation: none !important;/);
  });

  it("no animation library", () => {
    expect(pkg).not.toMatch(/"(framer-motion|motion)"\s*:/);
  });
});

describe("motion: progress bars", () => {
  it("ease value and colour changes (context window, plan usage)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Progress } = await import("../web/src/components/ui/progress.js");
    const html = renderToStaticMarkup(createElement(Progress, { value: 40, max: 100 }));
    expect(html).toMatch(/data-slot="progress-indicator"[^>]*transition-\[transform,background-color\]/);
  });
});
