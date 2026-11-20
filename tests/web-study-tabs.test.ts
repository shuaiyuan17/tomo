import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Study tab strip scrolls sideways on a phone. With only overflow-x set,
// browsers compute overflow-y as auto too, so the strip also scrolled up and
// down a few pixels under a finger. It must only move horizontally.
describe("Study tab strip", () => {
  it("scrolls horizontally only", () => {
    const source = readFileSync(join(__dirname, "..", "web", "src", "study.tsx"), "utf8");
    const line = source.split("\n").find((l) => l.includes('aria-label={t("sections")}')) ?? "";
    expect(line).toContain("overflow-x-auto");
    expect(line).toContain("overflow-y-hidden");
    expect(line).toContain("touch-pan-x");
  });
});
