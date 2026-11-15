import { afterEach, expect, it, vi } from "vitest";
import { stream } from "../web/src/api.js";
import { onResume } from "../web/src/resume.js";

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
