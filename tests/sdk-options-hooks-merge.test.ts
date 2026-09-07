import { describe, expect, it } from "vitest";
import { mergeHooks } from "../src/agent/sdk-options.js";

describe("mergeHooks", () => {
  it("concatenates entries when two producers register the same event", () => {
    const a = { PreToolUse: [{ hooks: ["guard-a"] }] };
    const b = { PreToolUse: [{ hooks: ["guard-b"] }], PostToolBatch: [{ hooks: ["budget"] }] };
    const merged = mergeHooks(mergeHooks({}, a), b);
    // Before the fix, Object.assign would have left only guard-b here.
    expect(merged.PreToolUse).toEqual([{ hooks: ["guard-a"] }, { hooks: ["guard-b"] }]);
    expect(merged.PostToolBatch).toEqual([{ hooks: ["budget"] }]);
  });

  it("keeps producers that use different events independent", () => {
    const merged = mergeHooks(mergeHooks({}, { A: [1] }), { B: [2] });
    expect(merged).toEqual({ A: [1], B: [2] });
  });

  it("ignores non-array values instead of throwing", () => {
    const merged = mergeHooks({}, { A: "nope" as unknown });
    expect(merged).toEqual({});
  });
});
