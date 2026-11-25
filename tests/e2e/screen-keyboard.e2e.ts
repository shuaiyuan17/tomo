/** The floating Screen window stays fully above the iOS keyboard (keptAboveKeyboard, laid out by a real browser). */
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { keptAboveKeyboard, windowHeight } from "../../web/src/screen-stream.js";

let browser: Browser; let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage({ viewport: { width: 1194, height: 834 } }); });
afterAll(async () => { await browser?.close(); });

/** Lays the window out with `--app-height` set (or not) and returns its [top, bottom]. */
async function place(top: number, width: number, appHeight?: number): Promise<number[]> {
  const style = { width: `${width}px`, ...keptAboveKeyboard(top, windowHeight(width)) };
  return page.evaluate(({ style, appHeight }) => {
    document.body.innerHTML = "";
    if (appHeight === undefined) document.documentElement.style.removeProperty("--app-height");
    else document.documentElement.style.setProperty("--app-height", `${appHeight}px`);
    const el = document.createElement("div");
    Object.assign(el.style, { position: "fixed", left: "0px" }, style);
    document.body.append(el);
    const r = el.getBoundingClientRect();
    return [Math.round(r.top), Math.round(r.bottom)];
  }, { style, appHeight });
}

it("without a keyboard the window sits where it was put, at its full size", async () => {
  const h = windowHeight(500);
  expect(await place(300, 500)).toEqual([300, 300 + h]);
});

it("a keyboard moves it up just enough", async () => {
  const h = windowHeight(300);
  expect(await place(500, 300, 434)).toEqual([434 - h, 434]);
});

it("a visible area shorter than the window cuts it down to fit, top at 0 (iPad landscape keyboard)", async () => {
  expect(windowHeight(560)).toBeGreaterThan(300);
  expect(await place(400, 560, 300)).toEqual([0, 300]);
});
