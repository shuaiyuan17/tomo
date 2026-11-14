import { describe, expect, it } from "vitest";
import { createCompositionGuard } from "../web/src/compose-keys.js";

function guard() {
  const queue: Array<() => void> = [];
  return { g: createCompositionGuard((fn) => { queue.push(fn); }), flush: () => { while (queue.length) queue.shift()!(); } };
}
const enter = { key: "Enter", shiftKey: false };

describe("Enter-to-send with input methods", () => {
  it("plain Enter sends; Shift+Enter is a new line; other keys do nothing", () => {
    const { g } = guard();
    expect(g.shouldSubmit(enter)).toBe(true);
    expect(g.shouldSubmit({ ...enter, shiftKey: true })).toBe(false);
    expect(g.shouldSubmit({ key: "a", shiftKey: false })).toBe(false);
  });
  it("Safari order: compositionend, then the confirming Enter (isComposing already false) does not send", () => {
    const { g, flush } = guard();
    g.start();
    expect(g.shouldSubmit({ ...enter, isComposing: true })).toBe(false);
    g.end();
    expect(g.shouldSubmit({ ...enter, isComposing: false })).toBe(false);
    flush();
    expect(g.shouldSubmit(enter)).toBe(true);
  });
  it("keyCode 229 (the IME is handling the key) never sends", () => {
    const { g } = guard();
    expect(g.shouldSubmit({ ...enter, keyCode: 229 })).toBe(false);
  });
  it("a new composition started before the deferred reset stays composing", () => {
    const { g, flush } = guard();
    g.start(); g.end(); g.start();
    flush();
    expect(g.shouldSubmit(enter)).toBe(false);
    g.end(); flush();
    expect(g.shouldSubmit(enter)).toBe(true);
  });
});
