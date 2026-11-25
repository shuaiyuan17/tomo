import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "./helpers/commander-run.js";

// `tomo cron`: the shell's way into the same jobs.json the daemon schedules
// from. The command builds ONE CronStore at import, from ~/.tomo, and its
// list()/get() serve what that store read then — right for a CLI process,
// which lives for one command. So HOME points at a scratch directory, and
// every run re-imports the command fresh (see `cron`), as a new process would.

const HOME = mkdtempSync(join(tmpdir(), "tomo-test-cron-cli-"));
vi.stubEnv("HOME", HOME);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(HOME, { recursive: true, force: true });
});
const { CronStore, isInterrupted } = await import("../src/cron/store.js");

const PATH = join(HOME, ".tomo", "data", "cron", "jobs.json");
/** `tomo cron <args...>`, in a "fresh process": modules reset, so the store reads the file now. */
async function cron(...args: string[]) {
  vi.resetModules();
  const { cronCommand } = await import("../src/cli/cron.js");
  return runCommand(cronCommand, args);
}
const store = () => new CronStore(PATH);
const NEVER_CRON = "0 0 30 2 *"; // February 30th: parses, never comes round

beforeEach(() => {
  rmSync(join(HOME, ".tomo"), { recursive: true, force: true });
  mkdirSync(join(HOME, ".tomo", "data", "cron"), { recursive: true });
});

function addHourly(name = "hourly") {
  return store().add({ name, schedule: { kind: "every", everyMs: 3_600_000 }, message: `do ${name}`, sessionKey: "dm:alice" });
}

describe("tomo cron add", () => {
  it("writes the job the daemon will read, and says what it created", async () => {
    const run = await cron("add", "--name", "standup", "--schedule", "0 9 * * 1-5", "--message", "post the standup", "--session", "telegram:-100777");
    expect(run.code).toBe(0);
    const [job] = store().list();
    expect(job).toMatchObject({ name: "standup", message: "post the standup", sessionKey: "telegram:-100777", deleteAfterRun: false, enabled: true });
    expect(job.schedule).toMatchObject({ kind: "cron", expr: "0 9 * * 1-5" });
    expect(run.out).toContain(`Created job ${job.id}: "standup"`);
    expect(run.out).toContain("Type:     recurring");
  });

  it("makes a one-time schedule a one-shot unless told otherwise, and stores --stale-after", async () => {
    await cron("add", "--name", "soon", "--schedule", "in 20m", "--message", "x", "--session", "dm:alice", "--stale-after", "0");
    await cron("add", "--name", "kept", "--schedule", "every 1h", "--message", "x", "--session", "dm:alice", "--once");
    const byName = Object.fromEntries(store().list().map((j) => [j.name, j]));
    expect(byName.soon).toMatchObject({ deleteAfterRun: true, staleAfterMs: 0 });
    expect(byName.soon.schedule.kind).toBe("at");
    expect(byName.kept.deleteAfterRun).toBe(true);
  });

  it.each([
    ["a time already past", ["--schedule", new Date(Date.now() - 86_400_000).toISOString()], /is in the past, so the job could never fire/],
    ["a pattern that never comes round", ["--schedule", NEVER_CRON], /has no future occurrence/],
    ["a typo", ["--schedule", "whenever i feel like it"], /not a schedule expression/],
    ["a bad --stale-after", ["--schedule", "every 1h", "--stale-after", "soon"], /Invalid --stale-after "soon"/],
  ])("refuses %s with exit 1 and writes nothing", async (_label, extra, message) => {
    const run = await cron("add", "--name", "x", "--message", "x", "--session", "dm:alice", ...extra);
    expect(run).toMatchObject({ code: 1, out: "" });
    expect(run.err).toMatch(message);
    expect(run.err.trim().split("\n")).toHaveLength(1); // one line, no stack trace
    expect(existsSync(PATH)).toBe(false);
  });
});

describe("tomo cron list", () => {
  it("says so when there is nothing scheduled", async () => {
    expect(await cron("list")).toMatchObject({ code: 0, out: "No scheduled tasks.\n" });
  });

  it("prints each job with its state, schedule and catch-up window", async () => {
    const job = addHourly();
    store().setEnabled(job.id, false);
    const run = await cron("list");
    expect(run.out).toContain(`[${job.id}] hourly (disabled, recurring)`);
    expect(run.out).toContain("Message:  do hourly");
    expect(run.out).toContain("Next run: —");
    expect(run.out).toContain("Last run: never");
    expect(run.out).toContain("Catch-up:  skip if more than 30m late (default)");
  });
});

describe("tomo cron remove / disable / edit", () => {
  it("remove deletes the job; an unknown id is exit 1", async () => {
    const job = addHourly();
    expect(await cron("remove", job.id)).toMatchObject({ code: 0, out: `Removed job ${job.id}\n` });
    expect(store().list()).toEqual([]);
    expect(await cron("remove", job.id)).toMatchObject({ code: 1, err: `Job ${job.id} not found\n` });
  });

  it("disable keeps the job and stops it; an unknown id is exit 1", async () => {
    const job = addHourly();
    expect((await cron("disable", job.id)).out).toBe(`Disabled job ${job.id}: "hourly"\n`);
    expect(store().get(job.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await cron("disable", "nope1234")).code).toBe(1);
  });

  it("edit --stale-after sets, resets to the default, and refuses what it cannot read", async () => {
    const job = addHourly();
    expect((await cron("edit", job.id, "--stale-after", "0")).out).toContain("always catches up");
    expect(store().get(job.id)!.staleAfterMs).toBe(0);
    expect((await cron("edit", job.id, "--stale-after", "default")).out).toContain("skipped if more than 30m late");
    expect("staleAfterMs" in store().get(job.id)!).toBe(false);

    for (const args of [["edit", job.id], ["edit", job.id, "--stale-after", "later"], ["edit", "nope1234", "--stale-after", "0"]]) {
      expect((await cron(...args)).code, args.join(" ")).toBe(1);
    }
    expect("staleAfterMs" in store().get(job.id)!).toBe(false);
  });
});

describe("tomo cron enable", () => {
  it("brings back a one-shot parked after an interrupted run, for good", async () => {
    const job = store().add({ name: "order", schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() }, message: "x", sessionKey: "dm:alice" });
    store().markStarted(job.id); // ...and the daemon died mid-turn
    store().recoverInterrupted();
    expect(store().get(job.id)).toMatchObject({ enabled: false, lastStatus: "interrupted" });

    const run = await cron("enable", job.id);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(new RegExp(`^Enabled job ${job.id}: "order" — next run `));
    const after = store().get(job.id)!;
    expect(after).toMatchObject({ enabled: true, lastStatus: null });
    expect(after.nextRunAt).not.toBeNull();
    expect(isInterrupted(after)).toBe(false);
    // The next daemon start does not park it all over again.
    expect(store().recoverInterrupted().parked).toEqual([]);
  });

  it("refuses a recurring job with no occurrence left, and leaves it disabled", async () => {
    const job = store().add({ name: "feb30", schedule: { kind: "cron", expr: NEVER_CRON }, message: "x", sessionKey: "dm:alice" });
    store().setEnabled(job.id, false);
    const run = await cron("enable", job.id);
    expect(run.code).toBe(1);
    expect(run.err).toContain(`Cannot enable job ${job.id}: it has no future occurrence, so it could never fire.`);
    expect(store().get(job.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await cron("enable", "nope1234")).code).toBe(1);
  });
});

describe("tomo cron run", () => {
  it("only previews: no dispatch record, nothing changed on disk", async () => {
    // A real dispatch record would read as an interrupted run at the next
    // daemon start, and park or report a job nobody ran.
    const job = addHourly();
    const before = readFileSync(PATH, "utf-8");
    const run = await cron("run", job.id);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`Would trigger: [${job.id}] hourly`);
    expect(run.out).toContain("this just previews");
    expect(readFileSync(PATH, "utf-8")).toBe(before);
    expect((await cron("run", "nope1234")).code).toBe(1);
  });
});

describe("an unreadable store", () => {
  it.each([
    ["list"], ["remove", "abc12345"], ["enable", "abc12345"], ["disable", "abc12345"],
    ["edit", "abc12345", "--stale-after", "0"], ["run", "abc12345"],
    ["add", "--name", "x", "--schedule", "every 1h", "--message", "x", "--session", "dm:alice"],
  ])("tomo cron %s exits 1, names the file instead of a stack trace, and writes nothing", async (...args) => {
    writeFileSync(PATH, "{ not json");
    const run = await cron(...args);
    expect(run).toMatchObject({ code: 1, out: "" });
    expect(run.err).toContain(`cron store unreadable: ${PATH}`);
    expect(readFileSync(PATH, "utf-8")).toBe("{ not json");
  });
});
