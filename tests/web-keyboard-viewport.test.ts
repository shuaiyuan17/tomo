import { expect, it } from "vitest";
import { APP_HEIGHT_VAR, VIEWPORT_TOP_VAR, trackKeyboardViewport } from "../web/src/keyboard-viewport.js";

function fakePage(height = 834) {
  const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 });
  const doc = new EventTarget();
  const vars = new Map<string, string>();
  const root = { style: { setProperty: (k: string, v: string) => { vars.set(k, v); }, removeProperty: (k: string) => { vars.delete(k); return ""; } } };
  const scrolls: Array<[number, number]> = [];
  const win = { scrollX: 0, scrollY: 0, scrollTo(x: number, y: number) { scrolls.push([x, y]); win.scrollX = x; win.scrollY = y; } };
  const frames: Array<() => void> = [];
  const flush = () => { while (frames.length) frames.shift()!(); };
  const stop = trackKeyboardViewport({ viewport: viewport as never, doc: doc as never, root: root as never, win,
    frame: (cb) => frames.push(cb), cancelFrame: () => { frames.length = 0; } });
  return { viewport, doc, vars, win, scrolls, flush, stop };
}

it("sizes the app to the visible area and puts back the scroll Safari does for the keyboard", () => {
  const page = fakePage();
  expect(page.vars.get(APP_HEIGHT_VAR)).toBe("834px");
  // Keyboard up: the visual viewport shrinks and Safari scrolls the document.
  page.viewport.height = 434.4;
  page.win.scrollY = 400;
  page.viewport.dispatchEvent(new Event("resize"));
  page.viewport.dispatchEvent(new Event("scroll"));
  page.flush();
  expect(page.vars.get(APP_HEIGHT_VAR)).toBe("434px");
  expect(page.win.scrollY).toBe(0);
  expect(page.scrolls).toEqual([[0, 0]]);
  expect(page.vars.has(VIEWPORT_TOP_VAR)).toBe(false);
  // Keyboard down.
  page.viewport.height = 834;
  page.viewport.dispatchEvent(new Event("resize"));
  page.flush();
  expect(page.vars.get(APP_HEIGHT_VAR)).toBe("834px");
});

it("leaves the scroll alone while an IME is composing, and settles on compositionend", () => {
  const page = fakePage();
  page.doc.dispatchEvent(new Event("compositionstart"));
  page.viewport.height = 380; // the candidate bar grows over the keyboard
  page.win.scrollY = 120;
  page.viewport.dispatchEvent(new Event("resize"));
  page.flush();
  expect(page.vars.get(APP_HEIGHT_VAR)).toBe("380px");
  expect(page.scrolls).toEqual([]);
  // The shell follows the kept scroll meanwhile, so the top bar stays in view.
  expect(page.vars.get(VIEWPORT_TOP_VAR)).toBe("120px");
  page.doc.dispatchEvent(new Event("compositionend"));
  page.flush();
  expect(page.scrolls).toEqual([[0, 0]]);
  expect(page.vars.has(VIEWPORT_TOP_VAR)).toBe(false);
});

it("follows a pan of the visual viewport that left the document unscrolled", () => {
  const page = fakePage();
  page.viewport.height = 434;
  page.viewport.offsetTop = 300;
  page.viewport.dispatchEvent(new Event("scroll"));
  page.flush();
  expect(page.scrolls).toEqual([]);
  expect(page.vars.get(VIEWPORT_TOP_VAR)).toBe("300px");
  page.viewport.offsetTop = 0;
  page.viewport.height = 834;
  page.viewport.dispatchEvent(new Event("resize"));
  page.flush();
  expect(page.vars.has(VIEWPORT_TOP_VAR)).toBe(false);
});

it("does nothing to a pinch-zoomed page, and cleans up when stopped", () => {
  const page = fakePage();
  page.viewport.offsetTop = 300;
  page.viewport.dispatchEvent(new Event("scroll"));
  page.flush();
  page.viewport.scale = 2;
  page.viewport.height = 417;
  page.win.scrollY = 200;
  page.viewport.dispatchEvent(new Event("scroll"));
  page.flush();
  expect(page.vars.has(APP_HEIGHT_VAR)).toBe(false);
  expect(page.vars.has(VIEWPORT_TOP_VAR)).toBe(false);
  expect(page.scrolls).toEqual([]);
  page.viewport.scale = 1;
  page.stop();
  expect(page.vars.has(APP_HEIGHT_VAR)).toBe(false);
  page.viewport.dispatchEvent(new Event("resize"));
  page.flush();
  expect(page.vars.has(APP_HEIGHT_VAR)).toBe(false);
});

it("is a no-op without a visual viewport (old browsers)", () => {
  expect(() => trackKeyboardViewport({ viewport: null })()).not.toThrow();
});
