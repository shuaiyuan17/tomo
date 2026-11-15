import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The first write is slow, so an unserialized second write would land first.
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, appendFile: async (...args: Parameters<typeof real.appendFile>) => {
    if (String(args[1]).includes("\"percent\":10,")) await new Promise((r) => setTimeout(r, 30));
    return real.appendFile(...args);
  } };
});
vi.mock("../src/logger.js", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { LimitsLog } from "../src/usage/limits-log.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "tomo-limits-order-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

it("A then B, not awaited: lines land in call order, and dedup follows the last line", async () => {
  const log = new LimitsLog(home, () => Date.parse("2026-11-15T20:00:00Z"));
  const a = { five_hour: { utilization: 10 } };
  const b = { five_hour: { utilization: 20 } };
  await Promise.all([log.recordOAuthUsage(a), log.recordOAuthUsage(b)]);
  const percents = () => readFileSync(log.path, "utf8").trim().split("\n").map((l) => JSON.parse(l).windows[0].percent);
  expect(percents()).toEqual([10, 20]);
  await log.recordOAuthUsage(b); // the file ends in B: an unchanged B is skipped
  await log.recordOAuthUsage(a); // A differs from the last line: written
  expect(percents()).toEqual([10, 20, 10]);
});
