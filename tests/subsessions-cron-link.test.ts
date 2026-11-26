import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/cron/store.js";
import { createTaskCronLink } from "../src/agent/subsessions/cron-link.js";
import { breakStore } from "./helpers/cron.js";

let dir = "";
let path = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-cronlink-")); path = join(dir, "data", "tomo.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const add = (store: CronStore, sessionKey: string) =>
  store.add({ name: "check", schedule: { kind: "every", everyMs: 60_000 }, message: "m", sessionKey });

describe("a task's cron jobs", () => {
  it("sees jobs another store instance added or removed after it was made", () => {
    const link = createTaskCronLink(path);
    expect(link.count("task:s1")).toBe(0);
    const writer = new CronStore(path);
    const job = add(writer, "task:s1");
    add(writer, "dm:owner");
    expect(link.count("task:s1")).toBe(1);
    new CronStore(path).remove(job.id);
    expect(link.count("task:s1")).toBe(0);
  });

  it("removes only that task's jobs, including ones added after it was made", () => {
    const link = createTaskCronLink(path);
    const writer = new CronStore(path);
    add(writer, "task:s1"); add(writer, "task:s1"); add(writer, "task:s2");
    link.removeAll("task:s1");
    expect(new CronStore(path).list().map((j) => j.sessionKey)).toEqual(["task:s2"]);
  });

  it("answers unknown, not zero, when the cron store cannot be read, and refuses to remove", () => {
    const link = createTaskCronLink(path);
    add(new CronStore(path), "task:s1");
    breakStore(path, "{broken");
    expect(link.count("task:s1")).toBeUndefined();
    expect(() => link.removeAll("task:s1")).toThrow();
  });
});
