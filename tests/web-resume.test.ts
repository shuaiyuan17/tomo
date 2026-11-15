import { afterEach, expect, it, vi } from "vitest";
import { stream } from "../web/src/api.js";
import { nudgeBrowserChrome, onResume } from "../web/src/resume.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function fakePage() {
  const doc = new EventTarget() as EventTarget & { hidden: boolean };
  doc.hidden = false;
  const view = new EventTarget();
  return { doc, view, hide: (hidden: boolean) => { doc.hidden = hidden; doc.dispatchEvent(new Event("visibilitychange")); },
    pageshow: (persisted: boolean) => view.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })) };
}

it("onResume: fires on hidden → visible with how long it was away, and on a bfcache restore", () => {
  const page = fakePage();
  let now = 1_000;
  const seen: number[] = [];
  const stop = onResume((hiddenFor) => seen.push(hiddenFor), page.doc as never, page.view as never, () => now);
  page.hide(false); // visible → visible: nothing
  page.hide(true); now += 30_000; page.hide(false);
  page.pageshow(false); // a first load: nothing
  page.pageshow(true);
  expect(seen).toEqual([30_000, Infinity]);
  stop();
  page.hide(true); page.hide(false); page.pageshow(true);
  expect(seen).toHaveLength(2);
});

it("stream: gives up a connection that goes quiet (no heartbeat) instead of waiting forever", async () => {
  vi.useFakeTimers();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  const done = stream("c", new AbortController().signal, { snapshot: () => {}, update: () => {}, cursor: () => {} }, 1_000);
  const outcome = expect(done).rejects.toThrow("Stream went quiet");
  await vi.advanceTimersByTimeAsync(1_500);
  await outcome;
});

it("nudgeBrowserChrome: scrolls the document by a pixel and back, touches theme-color, and leaves nothing behind", () => {
  const frames: (() => void)[] = [];
  const scrolls: number[] = [];
  const children: { remove(): void }[] = [];
  const metas = [{ content: "#f4efe6" }, { content: "#1e1c1b" }];
  const seenColours: string[] = [];
  const doc = {
    createElement: () => { const el = { style: {} as Record<string, string>, setAttribute() {}, remove() { children.splice(children.indexOf(el), 1); } }; return el; },
    querySelectorAll: () => metas,
    body: { appendChild: (el: { remove(): void }) => { children.push(el); return el; } },
  };
  const view = { scrollY: 0, scrollTo: (_x: number, y: number) => { scrolls.push(y); seenColours.push(...metas.map((m) => m.content)); }, requestAnimationFrame: (cb: () => void) => { frames.push(cb); return frames.length; } };
  nudgeBrowserChrome(doc as never, view as never);
  expect(scrolls).toEqual([1]);
  expect(children).toHaveLength(1);
  expect(metas.map((m) => m.content)).not.toEqual(["#f4efe6", "#1e1c1b"]);
  frames.shift()!();
  expect(scrolls).toEqual([1, 0]);
  expect(metas.map((m) => m.content)).toEqual(["#f4efe6", "#1e1c1b"]);
  frames.shift()!();
  expect(children).toHaveLength(0);
});
