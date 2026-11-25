import { describe, expect, it } from "vitest";
import { configLoader } from "./helpers/config-loader.js";

/**
 * `usesLcmCompact` decides whether a session's context is managed by Tomo's
 * LCM (nudges, rollups) or left to someone else. Every other test that
 * touches it mocks it, so this is the one place its rule is pinned.
 */
const { load } = configLoader("tomo-lcm-compact-");

async function usesLcmCompactWith(file: Record<string, unknown>): Promise<(key: string) => boolean> {
  await load(file);
  const { usesLcmCompact } = await import("../src/agent/sdk-options.js");
  return usesLcmCompact;
}

describe("usesLcmCompact", () => {
  it("keeps sub-sessions off LCM compaction (the harness sends /compact) and the owner's DM on it", async () => {
    const usesLcmCompact = await usesLcmCompactWith({});
    expect(usesLcmCompact("task:s1")).toBe(false);
    expect(usesLcmCompact("dm:owner")).toBe(true);
    // Groups follow lcm.groupCompactStyle, which defaults to "lcm".
    expect(usesLcmCompact("telegram:-1001234567")).toBe(true);
  });

  it("hands groups to SDK auto-compact when lcm.groupCompactStyle is \"sdk\", and only groups", async () => {
    const usesLcmCompact = await usesLcmCompactWith({ lcm: { groupCompactStyle: "sdk" } });
    expect(usesLcmCompact("telegram:-1001234567")).toBe(false);
    expect(usesLcmCompact("imessage:any;+;chat123")).toBe(false);
    expect(usesLcmCompact("dm:owner")).toBe(true);
  });
});
