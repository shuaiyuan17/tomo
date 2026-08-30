import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronStore } from "../src/cron/store.js";
import { buildCronTools } from "../src/mcp/cron-tools.js";

const TEST_DIR = join(tmpdir(), "tomo-test-cron-mcp");
const TEST_PATH = join(TEST_DIR, "jobs.json");

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function findTool(name: string): ToolHandle {
  const tools = buildCronTools(TEST_PATH) as unknown as ToolHandle[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`Tool ${name} not found`);
  return found;
}

describe("cron MCP tools", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("schedule_create — relative one-shot defaults to lifecycle 'once'", async () => {
    const tool = findTool("schedule_create");
    const result = await tool.handler({
      name: "test-once",
      schedule: "in 20m",
      message: "ping",
      session: "dm:alice",
    }, {});

    expect(result.isError).toBeFalsy();
    const summary = JSON.parse(result.content[0].text);
    expect(summary.lifecycle).toBe("once");
    expect(summary.name).toBe("test-once");
    expect(summary.enabled).toBe(true);
    expect(summary.nextRunAt).toBeTruthy();
  });

  it("schedule_create — recurring cron defaults to lifecycle 'recurring'", async () => {
    const tool = findTool("schedule_create");
    const result = await tool.handler({
      name: "daily",
      schedule: "0 9 * * *",
      message: "morning",
      session: "dm:alice",
    }, {});

    const summary = JSON.parse(result.content[0].text);
    expect(summary.lifecycle).toBe("recurring");
    expect(summary.schedule.kind).toBe("cron");
  });

  it("schedule_create — explicit once=true on a cron expression overrides default", async () => {
    const tool = findTool("schedule_create");
    const result = await tool.handler({
      name: "single-may1",
      schedule: "0 19 1 5 *",
      message: "fire once",
      session: "dm:alice",
      once: true,
    }, {});

    const summary = JSON.parse(result.content[0].text);
    expect(summary.lifecycle).toBe("once");
  });

  it("schedule_list — returns all jobs with summary fields", async () => {
    // Seed via the underlying store (proves MCP and CLI share the file).
    const seed = new CronStore(TEST_PATH);
    seed.add({
      name: "from-cli",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });

    const tool = findTool("schedule_list");
    const result = await tool.handler({}, {});
    const jobs = JSON.parse(result.content[0].text);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("from-cli");
    expect(jobs[0].lifecycle).toBe("recurring");
    expect(jobs[0].sessionKey).toBe("dm:alice");
    expect(jobs[0].nextRunAt).toBeTruthy();
  });

  it("schedule_enable — brings back a job left disabled by an interrupted run", async () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "remind me",
      sessionKey: "dm:alice",
    });
    // Dispatched, then the daemon died mid-run; recovery disables it rather
    // than firing a second time. The agent's only way back was to re-create
    // the job from scratch.
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(false);

    const result = await findTool("schedule_enable").handler({ id: job.id }, {});
    expect(result.isError).toBeFalsy();
    const summary = JSON.parse(result.content[0].text);
    expect(summary.enabled).toBe(true);
    expect(summary.lastStatus).toBeNull();
    expect(summary.nextRunAt).toBeTruthy();

    // And the fix sticks: the next daemon start must not settle it as
    // interrupted all over again.
    const outcome = new CronStore(TEST_PATH).recoverInterrupted();
    expect(outcome.skipped).toHaveLength(0);
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(true);
  });

  it("schedule_enable — disables without deleting, and reports a missing job", async () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "daily",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "morning",
      sessionKey: "dm:alice",
    });

    const off = await findTool("schedule_enable").handler({ id: job.id, enabled: false }, {});
    const summary = JSON.parse(off.content[0].text);
    expect(summary.enabled).toBe(false);
    expect(summary.nextRunAt).toBeNull();
    expect(new CronStore(TEST_PATH).list()).toHaveLength(1);

    const missing = await findTool("schedule_enable").handler({ id: "nope1234" }, {});
    expect(missing.content[0].text).toContain("not found");
  });

  it("schedule_list — surfaces the interrupted state and the dispatch time", async () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "hourly",
      schedule: { kind: "every", everyMs: 3_600_000 },
      message: "tick",
      sessionKey: "dm:alice",
    });
    store.markStarted(job.id);
    new CronStore(TEST_PATH).recoverInterrupted();

    const result = await findTool("schedule_list").handler({}, {});
    const [summary] = JSON.parse(result.content[0].text);
    expect(summary.lastStatus).toBe("interrupted");
    expect(summary.lastStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("schedule_remove — removes existing job; not-found returns text without isError", async () => {
    const create = findTool("schedule_create");
    const created = await create.handler({
      name: "to-remove",
      schedule: "in 1h",
      message: "x",
      session: "dm:alice",
    }, {});
    const job = JSON.parse(created.content[0].text);

    const remove = findTool("schedule_remove");
    const result = await remove.handler({ id: job.id }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Removed");

    // Not-found is a normal flow outcome (list → pick → remove can race), so
    // the tool reports it via the text but does not flag isError — flagging
    // would push the agent toward retry/escalate semantics.
    const missing = await remove.handler({ id: "deadbeef" }, {});
    expect(missing.isError).toBeFalsy();
    expect(missing.content[0].text).toContain("not found");
  });

  it("schedule_create — invalid schedule never lands a writable job", async () => {
    const create = findTool("schedule_create");
    const result = await create.handler({
      name: "bad",
      schedule: "this is not a schedule",
      message: "x",
      session: "dm:alice",
    }, {});

    // parseScheduleString falls through unknown strings to kind: "cron",
    // so the explicit catch in the handler may or may not fire depending
    // on whether croner rejects the expression at computeNextRun time.
    // Either path is acceptable — what matters is that the tool never
    // produces a job that the agent could mistake for "successfully
    // scheduled and ready to fire".
    if (result.isError) {
      // Handler caught the parse failure and surfaced it cleanly.
      expect(result.content[0].text).toMatch(/invalid schedule/i);
      const list = findTool("schedule_list");
      const listResult = await list.handler({}, {});
      expect(JSON.parse(listResult.content[0].text)).toHaveLength(0);
    } else {
      // croner accepted the string but couldn't compute a next run — the
      // job exists in the store but will never fire. Surface the latent
      // dead-job state so the agent doesn't pretend it's scheduled.
      const summary = JSON.parse(result.content[0].text);
      expect(summary.nextRunAt).toBeNull();
    }
  });

  it("MCP and CronStore see the same on-disk state (no in-memory drift)", async () => {
    const create = findTool("schedule_create");
    await create.handler({
      name: "via-mcp",
      schedule: "every 30m",
      message: "tick",
      session: "dm:alice",
    }, {});

    // Fresh store instance reads the file the MCP handler wrote to.
    const fresh = new CronStore(TEST_PATH);
    const found = fresh.list().find((j) => j.name === "via-mcp");
    expect(found).toBeTruthy();
    expect(found?.deleteAfterRun).toBe(false);

    // Conversely, a CLI add (via the underlying store) is visible to MCP list.
    fresh.add({
      name: "via-cli",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "later",
      sessionKey: "dm:alice",
    });

    const list = findTool("schedule_list");
    const listResult = await list.handler({}, {});
    const jobs = JSON.parse(listResult.content[0].text);
    const names = jobs.map((j: { name: string }) => j.name).sort();
    expect(names).toEqual(["via-cli", "via-mcp"]);
  });
});
