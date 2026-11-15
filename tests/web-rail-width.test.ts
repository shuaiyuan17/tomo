import { describe, expect, it } from "vitest";
import { CHAT_MIN, clampRailWidth, RAIL_MAX, RAIL_MIN, RAIL_WIDTH_KEY, railBounds, railDefaultWidth, safeLocalStorage, railWidthForKey, readRailWidth, writeRailWidth } from "../web/src/rail-width.js";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); }, data };
};

describe("Tasks rail width", () => {
  it("bounds: at least 280, at most 720 / half the viewport / what leaves the chat 480", () => {
    expect(railBounds(1440, 272)).toEqual({ min: RAIL_MIN, max: 1440 - 272 - CHAT_MIN });
    expect(railBounds(2400, 272)).toEqual({ min: RAIL_MIN, max: RAIL_MAX });
    expect(railBounds(1200, 0)).toEqual({ min: RAIL_MIN, max: 600 });
    // Too narrow to give the rail 280 and the chat 480: no resizing.
    expect(railBounds(1000, 272)).toBeNull();
  });

  it("the default follows the stylesheet (300, or 280 at 1024 and below) and is never below the minimum", () => {
    expect(railDefaultWidth(1440)).toBe(300);
    expect(railDefaultWidth(1024)).toBe(280);
    for (const vw of [801, 1024, 1025, 1440, 2560]) expect(railDefaultWidth(vw)).toBeGreaterThanOrEqual(RAIL_MIN);
  });

  it("a browser that refuses localStorage (the property itself throws) leaves no storage, not an exception", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.defineProperty({}, "localStorage", { get() { throw new Error("SecurityError"); } }) });
    try { expect(safeLocalStorage()).toBeUndefined(); }
    finally { if (original) Object.defineProperty(globalThis, "window", original); else delete (globalThis as { window?: unknown }).window; }
  });

  it("clamps into the bounds", () => {
    const bounds = { min: 280, max: 600 };
    expect(clampRailWidth(100, bounds)).toBe(280);
    expect(clampRailWidth(450.4, bounds)).toBe(450);
    expect(clampRailWidth(9000, bounds)).toBe(600);
  });

  it("persists in localStorage and restores; junk or a reset reads as no choice", () => {
    const storage = memory();
    expect(readRailWidth(storage)).toBeNull();
    writeRailWidth(storage, 412.6);
    expect(storage.data.get(RAIL_WIDTH_KEY)).toBe("413");
    expect(readRailWidth(storage)).toBe(413);
    writeRailWidth(storage, null);
    expect(readRailWidth(storage)).toBeNull();
    storage.setItem(RAIL_WIDTH_KEY, "wide");
    expect(readRailWidth(storage)).toBeNull();
    expect(readRailWidth({ getItem: () => { throw new Error("denied"); } })).toBeNull();
  });

  it("keyboard: ArrowLeft widens, ArrowRight narrows, Shift steps further, Home/End go to the bounds", () => {
    const bounds = { min: 280, max: 600 };
    expect(railWidthForKey("ArrowLeft", false, 300, bounds)).toBe(316);
    expect(railWidthForKey("ArrowRight", false, 300, bounds)).toBe(284);
    expect(railWidthForKey("ArrowRight", false, 284, bounds)).toBe(280);
    expect(railWidthForKey("ArrowLeft", true, 300, bounds)).toBe(364);
    expect(railWidthForKey("Home", false, 450, bounds)).toBe(280);
    expect(railWidthForKey("End", false, 450, bounds)).toBe(600);
    expect(railWidthForKey("a", false, 450, bounds)).toBeUndefined();
  });
});
