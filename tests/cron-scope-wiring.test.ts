import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The predicate is stubbed to the rule this PR replaced — plain equality
 * between the job's session and the caller's. The point is not to test the
 * stub: it is to prove `schedule_enable` reaches its decision THROUGH
 * `canManageJob` rather than restating a rule inline, so the six unit tests
 * on the predicate actually govern the tool's behaviour. Swap the rule and
 * the tool's answer changes with it.
 */
const rule = { equalityOnly: false };

vi.mock("../src/cron/scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cron/scope.js")>();
  return {
    ...actual,
    canManageJob: (job: { sessionKey?: string }, caller?: string) =>
      rule.equalityOnly
        ? caller === undefined || job.sessionKey === caller
        : actual.canManageJob(job as never, caller),
  };
});

const { CronStore } = await import("../src/cron/store.js");
const { buildCronTools } = await import("../src/mcp/cron-tools.js");

const TEST_DIR = join(tmpdir(), "tomo-test-cron-scope-wiring");
const TEST_PATH = join(TEST_DIR, "jobs.json");

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function enableTool(callerSessionKey: string): ToolHandle {
  const tools = buildCronTools(TEST_PATH, callerSessionKey) as unknown as ToolHandle[];
  return tools.find((t) => t.name === "schedule_enable")!;
}

describe("schedule_enable routes its decision through canManageJob", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    rule.equalityOnly = false;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rule.equalityOnly = false;
  });

  function seedGroupJob() {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "group-standup",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "standup",
      sessionKey: "telegram:-100270",
    });
    store.setEnabled(job.id, false);
    return job;
  }

  it("allows the owner's DM onto a group job under the shipped rule", async () => {
    const job = seedGroupJob();
    const result = await enableTool("dm:shuai").handler({ id: job.id }, {});
    expect(result.isError).toBeFalsy();
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(true);
  });

  it("denies the same call when the predicate is the old equality rule", async () => {
    const job = seedGroupJob();
    rule.equalityOnly = true;
    const result = await enableTool("dm:shuai").handler({ id: job.id }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("different session");
    // And the job stayed disabled — the denial is real, not cosmetic.
    expect(new CronStore(TEST_PATH).list()[0].enabled).toBe(false);
  });
});
