import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awaitingOutput } from "../web/src/chat-rows.js";
import { HistorySkeleton, ThinkingDots } from "../web/src/conversation-rows.js";
import { APPEARED_HOLD_MS, appendedIds, ENTER_MS, heldIds, measureExit, resumeDelay } from "../web/src/motion.js";

describe("motion: what counts as appearing", () => {
  it("only ids appended after the known ones animate; older pages loaded above do not", () => {
    const known = new Set(["c", "d"]);
    expect([...appendedIds(known, ["a", "b", "c", "d", "e", "f"])]).toEqual(["e", "f"]);
    expect([...appendedIds(known, ["c", "d"])]).toEqual([]);
    expect([...appendedIds(new Set(), ["x", "y"])]).toEqual(["x", "y"]);
  });
});

describe("motion: an entrance plays once, to the end", () => {
  const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

  it("an id stays appeared through the renders that follow at once, for longer than any entrance, then leaves", () => {
    const at = new Map([["a", 1_000], ["b", 1_300]]);
    expect(heldIds(at, 1_350)).toEqual(["a", "b"]);
    expect(heldIds(at, 1_000 + APPEARED_HOLD_MS)).toEqual(["b"]);
    expect(heldIds(at, 1_300 + APPEARED_HOLD_MS)).toEqual([]);
    const longest = Math.max(...[...css.matchAll(/--motion-(?:quick|enter|move|grow):\s*(\d+)ms;/g)].map(([, ms]) => Number(ms)));
    expect(APPEARED_HOLD_MS).toBeGreaterThan(longest);
  });

  it("a recorded reply carries on the entrance its streamed block began, or is simply there once that is over", () => {
    expect(css).toContain(`--motion-enter: ${ENTER_MS}ms;`);
    expect(resumeDelay(1_000, 1_000)).toBe(0);
    expect(resumeDelay(1_000, 1_060)).toBe(-60);
    expect(resumeDelay(1_000, 1_000 + ENTER_MS)).toBeNull();
    expect(resumeDelay(1_000, 9_000)).toBeNull();
    expect(resumeDelay(1_000, 990)).toBe(0);
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

  it("every motion animation takes a shared duration token (120–300 ms) on a shared curve", () => {
    const tokens = new Map([...css.matchAll(/--motion-(quick|enter|move|grow):\s*(\d+)ms;/g)].map(([, name, ms]) => [name, Number(ms)]));
    expect([...tokens.keys()].sort()).toEqual(["enter", "grow", "move", "quick"]);
    for (const ms of tokens.values()) {
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(300);
    }
    const rules = [...css.matchAll(/animation:\s*[\w-]+\s+var\(--motion-(\w+)\)\s+var\(--ease-(?:soft|enter)\)/g)];
    expect(rules.length).toBeGreaterThan(8);
    for (const [, name] of rules) expect(tokens.has(name)).toBe(true);
    // No entrance, exit or move with a duration of its own, or off the curve.
    expect(css).not.toMatch(/animation:\s*(motion|collapsible|viz)-[\w-]+\s+\d+ms/);
    expect(css).not.toMatch(/animation:\s*(motion|collapsible|viz)-[\w-]+\s+var\(--motion-\w+\)\s+(?!var\(--ease-(?:soft|enter)\))/);
  });

  it("a new bubble's rise is visible: at least 240 ms, at least 10 px, on the gentler entrance curve", () => {
    const enter = Number(/--motion-enter:\s*(\d+)ms;/.exec(css)?.[1]);
    expect(enter).toBeGreaterThanOrEqual(240);
    expect(ENTER_MS).toBe(enter);
    const rise = Number(/@keyframes motion-enter \{ from \{[^}]*translateY\((\d+)px\)/.exec(css)?.[1]);
    expect(rise).toBeGreaterThanOrEqual(10);
    expect(css).toMatch(/\.motion-enter \{ animation: motion-enter var\(--motion-enter\) var\(--ease-enter\) both; \}/);
  });

  it("a new bubble or block only fades and rises: nothing that changes the transcript's height", () => {
    for (const name of ["motion-enter", "motion-fade", "thinking-dot"]) {
      const frames = new RegExp(`@keyframes ${name} \\{(.*)\\}\\s*$`, "m").exec(css)?.[1] ?? "";
      const props = [...frames.matchAll(/([a-z-]+):/g)].map(([, prop]) => prop);
      expect(props.length).toBeGreaterThan(0);
      expect(props.filter((prop) => prop !== "opacity" && prop !== "transform")).toEqual([]);
    }
  });

  it("a placeholder for a wait holds back before it fades in, so a quick load or reply never flashes one", () => {
    expect(css).toMatch(/--motion-wait:\s*300ms;/);
    expect(css).toMatch(/\.motion-wait \{ animation: motion-fade var\(--motion-enter\) var\(--ease-soft\) var\(--motion-wait\) backwards; \}/);
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

describe("motion: exits", () => {
  it("a card collapses from its real height", () => {
    const props = new Map<string, string>();
    const el = { offsetHeight: 87, style: { setProperty: (k: string, v: string) => props.set(k, v) } } as unknown as HTMLElement;
    measureExit(el);
    expect(props.get("--motion-exit-from")).toBe("87px");
    expect(readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8")).toMatch(/@keyframes motion-exit \{ from \{[^}]*height: var\(--motion-exit-from/);
  });
});

describe("motion: waiting", () => {
  it("the thinking dots show only while a running turn has shown nothing: no step, no text", () => {
    expect(awaitingOutput(true, 0, 0)).toBe(true);
    expect(awaitingOutput(false, 0, 0)).toBe(false);
    expect(awaitingOutput(true, 1, 0)).toBe(false);
    expect(awaitingOutput(true, 0, 1)).toBe(false);
  });

  it("the dots are for the eye only (the status line speaks), and wait before showing", () => {
    const html = renderToStaticMarkup(createElement(ThinkingDots));
    expect(html).toMatch(/aria-hidden="true"[^>]*class="motion-wait /);
    expect(html.match(/<i><\/i>/g)).toHaveLength(3);
  });

  it("the history skeleton is a status with the opening words for a screen reader, and waits before showing", () => {
    const html = renderToStaticMarkup(createElement(HistorySkeleton, { label: "Opening your conversation…" }));
    expect(html).toMatch(/^<div role="status"[^>]*class="motion-wait /);
    expect(html).toContain('<span class="sr-only">Opening your conversation…</span>');
    expect(html).toMatch(/aria-hidden="true" class="animate-pulse"/);
  });
});
