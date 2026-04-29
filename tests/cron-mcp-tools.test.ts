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

  it("schedule_remove — removes existing job and 404s on missing", async () => {
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

    const missing = await remove.handler({ id: "deadbeef" }, {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("not found");
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
