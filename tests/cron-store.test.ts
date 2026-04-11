import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CronStore, parseScheduleString } from "../src/cron/store.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-cron");
const TEST_PATH = join(TEST_DIR, "jobs.json");

describe("CronStore", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates and lists jobs", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "hello",
      sessionKey: "dm:alice",
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("test");
    expect(job.enabled).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it("removes jobs", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "hello",
      sessionKey: "dm:alice",
    });

    expect(store.remove(job.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.remove("nonexistent")).toBe(false);
  });

  it("persists to disk and reloads", () => {
    const store1 = new CronStore(TEST_PATH);
    store1.add({
      name: "persistent",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "morning",
      sessionKey: "telegram:12345",
    });

    const store2 = new CronStore(TEST_PATH);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].name).toBe("persistent");
  });

  it("finds due jobs", () => {
    const store = new CronStore(TEST_PATH);
    // "every" job with nextRunAt set to the past
    store.add({
      name: "overdue",
      schedule: { kind: "every", everyMs: 1000 },
      message: "past",
    });
    // Manually set nextRunAt to the past
    const job = store.list()[0];
    job.nextRunAt = Date.now() - 1000;

    store.add({
      name: "future",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "later",
      sessionKey: "dm:alice",
    });

    const due = store.getDueJobs();
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe("overdue");
  });

  it("marks run and updates state", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "recurring",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    store.markRun(job.id, "ok");
    const updated = store.get(job.id)!;
    expect(updated.lastStatus).toBe("ok");
    expect(updated.lastRunAt).toBeTruthy();
    expect(updated.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("disables one-shot jobs after run", () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "once",
      schedule: { kind: "at", at: new Date(Date.now() - 1000).toISOString() },
      message: "fire once",
      sessionKey: "dm:alice",
    });

    store.markRun(job.id, "ok");
    // deleteAfterRun defaults to true for "at" jobs
    expect(store.get(job.id)).toBeUndefined();
  });

  it("rewrites sessionKey in bulk", () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "job-a",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "a",
      sessionKey: "telegram:12345",
    });
    store.add({
      name: "job-b",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "b",
      sessionKey: "telegram:12345",
    });
    store.add({
      name: "job-c",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "c",
      sessionKey: "imessage:+15551234567",
    });

    const count = store.rewriteSessionKey("telegram:12345", "dm:alice");
    expect(count).toBe(2);

    const reloaded = new CronStore(TEST_PATH);
    const jobs = reloaded.list();
    expect(jobs.find((j) => j.name === "job-a")?.sessionKey).toBe("dm:alice");
    expect(jobs.find((j) => j.name === "job-b")?.sessionKey).toBe("dm:alice");
    expect(jobs.find((j) => j.name === "job-c")?.sessionKey).toBe("imessage:+15551234567");
  });

  it("rewriteSessionKey returns 0 when no jobs match", () => {
    const store = new CronStore(TEST_PATH);
    store.add({
      name: "j",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "x",
      sessionKey: "dm:alice",
    });
    expect(store.rewriteSessionKey("telegram:nothing", "dm:bob")).toBe(0);
  });
});

describe("parseScheduleString", () => {
  it("parses relative time", () => {
    const s = parseScheduleString("in 20m");
    expect(s.kind).toBe("at");
    if (s.kind === "at") {
      const ts = new Date(s.at).getTime();
      expect(ts).toBeGreaterThan(Date.now());
      expect(ts).toBeLessThan(Date.now() + 25 * 60_000);
    }
  });

  it("parses interval", () => {
    const s = parseScheduleString("every 2h");
    expect(s).toEqual({ kind: "every", everyMs: 7_200_000 });
  });

  it("parses cron expression", () => {
    const s = parseScheduleString("0 9 * * *");
    expect(s.kind).toBe("cron");
    if (s.kind === "cron") {
      expect(s.expr).toBe("0 9 * * *");
      expect(s.tz).toBeTruthy();
    }
  });

  it("parses ISO date", () => {
    const s = parseScheduleString("2026-12-25T00:00:00Z");
    expect(s.kind).toBe("at");
  });
});
