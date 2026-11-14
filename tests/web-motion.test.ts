import { describe, expect, it } from "vitest";
import { appendedIds } from "../web/src/motion.js";

describe("motion: what counts as appearing", () => {
  it("only ids appended after the known ones animate; older pages loaded above do not", () => {
    const known = new Set(["c", "d"]);
    expect([...appendedIds(known, ["a", "b", "c", "d", "e", "f"])]).toEqual(["e", "f"]);
    expect([...appendedIds(known, ["c", "d"])]).toEqual([]);
    expect([...appendedIds(new Set(), ["x", "y"])]).toEqual(["x", "y"]);
  });
});
