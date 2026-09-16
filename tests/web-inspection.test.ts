import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryReader } from "../src/workspace/memory-reader.js";
import { CronStore } from "../src/cron/store.js";
import { WebCron, readSessionContext } from "../src/web/inspection.js";
import { computeContextStats } from "../src/lcm/stats.js";
import { readSummaryBlocks } from "../src/lcm/summary-reader.js";
import type { SessionEntry } from "../src/sessions/types.js";
let root: string; let memory: MemoryReader;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-inspection-test-")); mkdirSync(join(root, "memory", "topics"), { recursive: true }); memory = new MemoryReader(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
it("lists an index, topic subdirectories, read-only TODO checkbox markdown, and literal search", async () => {
  writeFileSync(join(root, "memory", "MEMORY.md"), "# Index\n[Topic](topics/topic.md)");
  writeFileSync(join(root, "memory", "TODO-work.md"), "- [x] Done\n- [ ] Next [literal]");
  writeFileSync(join(root, "memory", "topics", "topic.md"), "A topic [literal]");
  expect((await memory.tree()).entries.map((e) => e.path)).toContain("topics/topic.md");
  expect((await memory.todos()).files).toEqual([expect.objectContaining({ path: "TODO-work.md", content: "- [x] Done\n- [ ] Next [literal]" })]);
  expect((await memory.search("[literal]")).results).toHaveLength(2);
  expect((await memory.file("MEMORY.md")).content).toContain("# Index");
});
it.each(["../outside.md", "/outside.md", "topics/../../outside.md", "topics\\outside.md", "topics/./topic.md", "note.txt"])("rejects an unsafe memory path %s", async (path) => {
  await expect(memory.file(path)).rejects.toMatchObject({ code: "invalid_path" });
});
it("rejects file, directory, and root symlinks, plus hard links to outside files", async () => {
  writeFileSync(join(root, "outside.md"), "private outside content");
  symlinkSync(join(root, "outside.md"), join(root, "memory", "alias.md"));
  symlinkSync(root, join(root, "memory", "escape")); linkSync(join(root, "outside.md"), join(root, "memory", "hard.md"));
  await expect(memory.file("alias.md")).rejects.toThrow(); await expect(memory.file("escape/outside.md")).rejects.toThrow(); await expect(memory.file("hard.md")).rejects.toThrow();
  expect(JSON.stringify(await memory.search("private outside"))).not.toContain("private outside content");
  rmSync(join(root, "memory"), { recursive: true }); symlinkSync(root, join(root, "memory")); await expect(memory.tree()).rejects.toThrow();
});
it("bounds file reads and distinguishes missing memory from an empty result", async () => {
  writeFileSync(join(root, "memory", "large.md"), "x".repeat(256 * 1024 + 1)); await expect(memory.file("large.md")).rejects.toMatchObject({ code: "limit" });
  await expect(memory.file("missing.md")).rejects.toMatchObject({ code: "not_found" });
  rmSync(join(root, "memory"), { recursive: true }); expect(await memory.tree()).toMatchObject({ missing: true });
});
it("lists all cron fields and guards confirmed mutations against concurrent run updates", () => {
  const store = new CronStore(join(root, "data", "cron", "jobs.json")); const web = new WebCron(root);
  const job = store.add({ name: "Example task", schedule: { kind: "every", everyMs: 60_000 }, message: "Review the test note", sessionKey: "dm:owner" });
  const saved = web.list().jobs[0]; expect(saved).toMatchObject({ name: job.name, message: job.message, sessionKey: job.sessionKey, scheduleLabel: "every 1m", lastStatus: null });
  store.setEnabled(job.id, false);
  expect(() => web.change(job.id, saved.revision, true)).toThrow("cron_changed");
  web.change(job.id, web.list().jobs[0].revision, true); expect(web.list().jobs[0].enabled).toBe(true);
  web.change(job.id, web.list().jobs[0].revision); expect(web.list().jobs).toEqual([]);
});
it("uses the CLI token estimator and summary-block parser, retaining reported usage separately", async () => {
  const events = [
    { type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "An example message" } },
    { type: "assistant", timestamp: "2026-01-01T00:01:00Z", message: { content: [{ type: "text", text: "Example response" }] } },
    { isCompactSummary: true, blockTag: "daily 2026-01-01", timestamp: "2026-01-02T00:00:00Z", message: { content: "[daily 2026-01-01 — 2 events summarized]\n\nSummary" } },
  ];
  writeFileSync(join(root, "test-sdk.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
  const entry = { sdkSessionId: "test-sdk", lastActiveAt: 100, stats: { contextUsed: 4321, contextMax: 200000, contextEstimated: true } } as SessionEntry;
  const actual = await readSessionContext(entry, root);
  expect(actual).toMatchObject({ used: 4321, max: 200000, estimated: true, recordedAt: 100 });
  expect(actual.analysis).toMatchObject(computeContextStats("test-sdk", root)!);
  expect(actual.summaries).toMatchObject(readSummaryBlocks("test-sdk", root));
  expect(await readSessionContext(undefined, root)).toMatchObject({ used: null, max: null });
  expect(await readSessionContext({ stats: { contextUsed: 0, contextMax: 0 } } as SessionEntry, root)).toMatchObject({ used: null, max: null });
});

it("lets a confirmed cron disable/delete survive scheduler bookkeeping but rejects intent edits", () => {
  const store = new CronStore(join(root, "data", "cron", "jobs.json")); const web = new WebCron(root);
  const job = store.add({ name: "Frequent task", schedule: { kind: "every", everyMs: 30_000 }, message: "Example", sessionKey: "dm:owner" });
  const revision = web.list().jobs[0].revision;
  store.markStarted(job.id); store.markRun(job.id, "ok"); store.markStarted(job.id);
  expect(() => web.change(job.id, revision, false)).not.toThrow();
  expect(web.list().jobs[0]).toMatchObject({ enabled: false, lastStatus: "ok" });
  const disabledRevision = web.list().jobs[0].revision;
  store.markRun(job.id, "error");
  expect(() => web.change(job.id, disabledRevision)).not.toThrow();
  expect(web.list().jobs).toEqual([]);
});
it("exposes private memory to the authenticated owner browser and limits TODOs to the documented root glob", async () => {
  mkdirSync(join(root, "memory", "private"));
  writeFileSync(join(root, "memory", "private", "note.md"), "Owner-only test note");
  writeFileSync(join(root, "memory", "topics", "TODO-nested.md"), "- [ ] Nested note");
  writeFileSync(join(root, "memory", "TODO.md"), "- [ ] Root note");
  expect((await memory.tree()).entries.map((entry) => entry.path)).toContain("private/note.md");
  expect((await memory.file("private/note.md")).content).toBe("Owner-only test note");
  expect((await memory.search("Owner-only")).results[0].path).toBe("private/note.md");
  expect((await memory.todos()).files.map((file) => file.path)).toEqual(["TODO.md"]);
});
it.each(["large line", "many lines"])("bounds context parser allocations for %s while retaining persisted window usage", async (kind) => {
  writeFileSync(join(root, "bounded.jsonl"), kind === "large line"
    ? JSON.stringify({ type: "user", message: { content: "x".repeat(256 * 1024) } }) : "{}\n".repeat(20_001));
  const entry = { sdkSessionId: "bounded", stats: { contextUsed: 50, contextMax: 200000 } } as SessionEntry;
  expect(await readSessionContext(entry, root)).toMatchObject({ used: 50, max: 200000, analysis: null, analysisStatus: "too_large" });
});
it("bounds rollup previews while retaining the most recent summaries", async () => {
  const events = Array.from({ length: 105 }, (_, i) => ({ isCompactSummary: true, timestamp: String(i).padStart(3, "0"), message: { content: "s".repeat(9000) } }));
  writeFileSync(join(root, "summaries.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
  const value = await readSessionContext({ sdkSessionId: "summaries" } as SessionEntry, root);
  expect(value.summaries).toHaveLength(100); expect(value.summaries[0]).toMatchObject({ timestamp: "104", truncated: true });
  expect(value.summaries[0].content).toHaveLength(8000);
});
