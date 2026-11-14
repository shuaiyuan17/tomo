import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parse = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/cron/store.js", async (original) => {
  const real = await original<typeof import("../src/cron/store.js")>();
  return { ...real, parseCronStore: (...args: Parameters<typeof real.parseCronStore>) => { parse.calls++; return real.parseCronStore(...args); } };
});
const { WebCron } = await import("../src/web/inspection.js");

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-cron-cache-")); parse.calls = 0; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const store = (name: string) => JSON.stringify({ version: 1, revision: 1, jobs: [{ id: "j1", name, enabled: true,
  schedule: { kind: "every", everyMs: 60_000 }, message: "m", sessionKey: "dm:owner", deleteAfterRun: false,
  createdAt: 1, nextRunAt: 2, lastRunAt: null, lastStatus: null }] });

it("parses the store once while it is unchanged, and again after the store rewrites it", async () => {
  const path = join(root, "jobs.json");
  writeFileSync(path, store("first"));
  const cron = new WebCron(path);
  for (let i = 0; i < 5; i++) expect((await cron.list()).jobs[0].name).toBe("first");
  expect(parse.calls).toBe(1);
  // CronStore writes atomically (write a temp file, rename): a new inode.
  writeFileSync(join(root, "next.json"), store("second")); renameSync(join(root, "next.json"), path);
  expect((await cron.list()).jobs[0].name).toBe("second");
  expect(parse.calls).toBe(2);
  // An in-place edit changes size / ctime, so it is noticed too.
  writeFileSync(path, store("third, longer"));
  expect((await cron.list()).jobs[0].name).toBe("third, longer");
  expect(parse.calls).toBe(3);
});

it("does not cache a store it could not parse", async () => {
  const path = join(root, "jobs.json");
  writeFileSync(path, "{broken");
  const cron = new WebCron(path);
  await expect(cron.list()).rejects.toMatchObject({ code: "cron_unavailable" });
  await expect(cron.list()).rejects.toMatchObject({ code: "cron_unavailable" });
  expect(parse.calls).toBe(2);
});
