import { describe, expect, it } from "vitest";
import { Color, Group } from "three";
import { ease, signPixels, signScaleFor, stepPart, type PartRuntime } from "../web/src/home/three/build.js";
import { SIGN_PIXEL_BUDGET, signCanvasSize } from "../web/src/home/three/resources.js";
import { windowCanvasSize } from "../web/src/home/three/sky-canvas.js";
import { NO_EFFECTS, type PartEffects } from "../web/src/home/evaluate.js";
import type { LayoutNode } from "../web/src/home/layout.js";

// The pure arithmetic under the home's three.js renderer: how big each canvas
// texture is, and how a part eases to its target. home.e2e only checks pixels.

describe("canvas sizes", () => {
  it("a sign is 256 px per metre high (24 to 256), its width by its aspect, never over 1024 wide", () => {
    expect(signCanvasSize(2, 0.5)).toEqual([512, 128]);
    expect(signCanvasSize(0.05, 0.05)).toEqual([24, 24]);
    expect(signCanvasSize(0.5, 2)).toEqual([64, 256]);
    // Very wide: the width is held at 1024 and the height shrinks to keep the aspect.
    expect(signCanvasSize(16, 0.5)).toEqual([1024, 32]);
    // Never smaller than 16 x 8.
    expect(signCanvasSize(0.001, 1)).toEqual([16, 256]);
    expect(signCanvasSize(1000, 0.1)).toEqual([1024, 8]);
    // The budget's scale shrinks both sides.
    expect(signCanvasSize(2, 0.5, 0.5)).toEqual([256, 64]);
  });

  it("a window's sky is 192 px high, its width by its aspect, never over 512 wide, at least 16 either way", () => {
    expect(windowCanvasSize(1, 1)).toEqual([192, 192]);
    expect(windowCanvasSize(4, 1)).toEqual([512, 128]);
    expect(windowCanvasSize(100, 1)).toEqual([512, 16]);
    expect(windowCanvasSize(1, 100)).toEqual([16, 192]);
  });
});

describe("the sign pixel budget", () => {
  const sign = (w: number, h: number, extra: Partial<LayoutNode> = {}) => ({ type: "sign", size: [w, h, 0.02], children: [], carried: [], ...extra }) as unknown as LayoutNode;
  const group = (children: LayoutNode[], carried: LayoutNode[] = []) => ({ type: "group", size: [0, 0, 0], children, carried }) as unknown as LayoutNode;

  it("counts every sign's canvas, nested or carried, and nothing else", () => {
    const one = 512 * 128;
    expect(signPixels([sign(2, 0.5)])).toBe(one);
    expect(signPixels([group([sign(2, 0.5), group([], [sign(2, 0.5)])]), group([])])).toBe(2 * one);
  });

  it("draws at full size under the budget, and shrinks just enough over it to land on it", () => {
    expect(signScaleFor(0)).toBe(1);
    expect(signScaleFor(SIGN_PIXEL_BUDGET)).toBe(1);
    for (const pixels of [SIGN_PIXEL_BUDGET * 2, SIGN_PIXEL_BUDGET * 100]) {
      const scale = signScaleFor(pixels);
      expect(scale).toBeLessThan(1);
      // Scaling both sides by `scale` scales the area by its square.
      expect(pixels * scale * scale).toBeCloseTo(SIGN_PIXEL_BUDGET, -1);
    }
  });
});

describe("easing a part", () => {
  it("ease approaches its target and lands on it exactly", () => {
    expect(ease(0, 1, 0, 12)).toBe(0);
    const step = ease(0, 1, 0.05, 12);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(1);
    expect(ease(0.999, 1, 0.05, 12)).toBe(1);
    let value = 0;
    for (let frame = 0; frame < 120 && value !== 1; frame++) value = ease(value, 1, 1 / 60, 12);
    expect(value).toBe(1);
  });

  const part = (target: Partial<PartEffects>): PartRuntime => ({
    node: {} as LayoutNode, motion: new Group(), meshes: [], phase: 0, spinAngle: 0,
    target: { ...NO_EFFECTS, ...target },
    weights: { show: 0, glow: 0, tint: 0, bob: 0, spin: 0, swing: 0, pulse: 0 },
    last: { glow: null, tint: new Color(), bob: { amount: 0.1, speed: 1 }, swing: { amount: 10, speed: 1 }, pulse: { amount: 0.1, speed: 1 }, spin: 1 },
  });

  it("eases in over frames, and is done once there with nothing moving", () => {
    const shown = part({});
    expect(stepPart(shown, 1 / 60, 0, false)).toBe(true);
    expect(shown.weights.show).toBeGreaterThan(0);
    expect(shown.weights.show).toBeLessThan(1);
    let busy = true;
    for (let frame = 0; frame < 240 && busy; frame++) busy = stepPart(shown, 1 / 60, frame / 60, false);
    expect(busy).toBe(false);
    expect(shown.weights.show).toBe(1);
    expect(shown.motion.visible).toBe(true);
  });

  it("keeps asking for frames while a motion runs", () => {
    const bobbing = part({ bob: { amount: 0.1, speed: 1 } });
    for (let frame = 0; frame < 240; frame++) stepPart(bobbing, 1 / 60, frame / 60, false);
    expect(bobbing.weights.bob).toBe(1);
    expect(stepPart(bobbing, 1 / 60, 5, false)).toBe(true);
  });

  it("with reduced motion: states apply at once, motions never start, and it asks for no more frames", () => {
    const reduced = part({ bob: { amount: 0.1, speed: 1 }, spin: { amount: 1, speed: 1 } });
    expect(stepPart(reduced, 1 / 60, 3, true)).toBe(false);
    expect(reduced.weights).toMatchObject({ show: 1, bob: 0, spin: 0 });
    expect(reduced.motion.position.y).toBe(0);
    expect(reduced.motion.rotation.y).toBe(0);
  });
});
