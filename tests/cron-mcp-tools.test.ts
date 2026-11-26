import { afterAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronStore } from "../src/cron/store.js";
import { buildCronTools } from "../src/mcp/cron-tools.js";
import { breakStore } from "./helpers/cron.js";
import { MIXED_AUDIENCE_KEY } from "../src/agent/audience.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tomo-test-cron-mcp-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
const TEST_PATH = join(TEST_DIR, "data", "tomo.db");

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function findTool(name: string, caller?: string | (() => string)): ToolHandle {
  const tools = buildCronTools(TEST_PATH, caller) as unknown as ToolHandle[];
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

  it("schedule_create — accepts staleAfter, and reports the effective window", async () => {
    const created = await findTool("schedule_create", "dm:alice").handler(
      { name: "backup", schedule: "0 3 * * *", message: "run the backup", staleAfter: "0" }, {});
    expect(created.isError).toBeFalsy();
    const summary = JSON.parse(created.content[0].text);
    expect(summary.staleAfterMs).toBe(0);
    expect(summary.staleAfterSource).toBe("set");
    expect(new CronStore(TEST_PATH).list()[0].staleAfterMs).toBe(0);

    const dflt = JSON.parse((await findTool("schedule_create", "dm:alice").handler(
      { name: "hourly", schedule: "every 1h", message: "x" }, {})).content[0].text);
    expect(dflt).toMatchObject({ staleAfterMs: 30 * 60_000, staleAfterSource: "default" });

    const bad = await findTool("schedule_create", "dm:alice").handler({ name: "x", schedule: "every 1h", message: "x", staleAfter: "soon" }, {});
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('invalid staleAfter "soon"');
  });

  it("schedule_enable — brings back a job left disabled by an interrupted run", async () => {
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "one-shot",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      message: "remind me",
      sessionKey: "dm:alice",
    });
    // Dispatched, then the daemon died mid-turn; recovery parks it (every
    // interrupted one-shot is) rather than run it again. The agent's only way
    // back used to be re-creating the job from scratch.
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
    expect(outcome.parked).toHaveLength(0);
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

  it("schedule_enable — refuses a recurring job that has run out of occurrences", async () => {
    // `schedule_create` refuses the dead-job shape at creation; this is the
    // same shape reached from the other side. February 30th parses fine and
    // never comes round, so enabling used to write `enabled: true,
    // nextRunAt: null` — a job `schedule_list` reports as scheduled and the
    // 30s scan never picks up. The model then tells the user it is on.
    const store = new CronStore(TEST_PATH);
    const job = store.add({
      name: "feb 30th",
      schedule: { kind: "cron", expr: "0 0 30 2 *" },
      message: "never",
      sessionKey: "dm:alice",
    });
    store.setEnabled(job.id, false);

    const result = await findTool("schedule_enable").handler({ id: job.id }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could never fire/);
    expect(result.content[0].text).toMatch(/no future occurrence/);

    // Nothing changed on disk — no half-enabled job left behind.
    const after = new CronStore(TEST_PATH).get(job.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
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

  it("schedule_create — an unreadable store is not reported as an invalid schedule", async () => {
    breakStore(TEST_PATH, "{ not json");
    const result = await findTool("schedule_create").handler({
      name: "test",
      schedule: "every 1h",
      message: "ping",
      session: "dm:alice",
    }, {});

    expect(result.isError).toBe(true);
    // The schedule was fine. Saying otherwise sends the agent off rewriting a
    // perfectly good schedule string forever.
    expect(result.content[0].text).not.toContain("invalid schedule");
    expect(result.content[0].text).toContain("could not be read");
    expect(result.content[0].text).toContain("the schedule itself is valid");
  });

  it("schedule_create — refuses a target that is not a session key", async () => {
    for (const session of ["", "shuai", "dm:", "dm:alice\nreally:evil"]) {
      const result = await findTool("schedule_create").handler({
        name: "test",
        schedule: "every 1h",
        message: "ping",
        session,
      }, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("is not a session key");
    }
    // Nothing undeliverable was persisted.
    expect(new CronStore(TEST_PATH).list()).toHaveLength(0);
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

    // parseScheduleString falls through unknown strings to kind: "cron", so
    // croner may reject it at evaluation (a throw) or accept it and report no
    // future occurrence (null). Both are refusals now: a job the tool reports
    // as scheduled must be one the scan can actually pick up.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid schedule");
    const list = findTool("schedule_list");
    const listResult = await list.handler({}, {});
    expect(JSON.parse(listResult.content[0].text)).toHaveLength(0);
  });

  it("schedule_create — a time that has already passed is refused, not stored dead", async () => {
    // The shape that used to succeed: a perfectly parseable ISO date/time in
    // the past. computeNextRun returns null (not a throw), so the old trial
    // waved it through and `add` stored `enabled: true, nextRunAt: null` — a
    // task reported as scheduled that no scan can ever pick up. The user finds
    // out when the reminder does not arrive.
    const create = findTool("schedule_create");
    const result = await create.handler({
      name: "yesterday",
      schedule: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      message: "water the airplant",
      session: "dm:alice",
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid schedule");
    expect(result.content[0].text).toMatch(/in the past/i);

    // Nothing landed — not even a disabled record.
    expect(new CronStore(TEST_PATH).list()).toHaveLength(0);
  });

  it("MCP and CronStore see the same on-disk state (no in-memory drift); the list carries the summary fields", async () => {
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
    const viaCli = jobs.find((j: { name: string }) => j.name === "via-cli");
    expect(viaCli).toMatchObject({ lifecycle: "once", sessionKey: "dm:alice", enabled: true });
    expect(viaCli.nextRunAt).toBeTruthy();
    const viaMcp = jobs.find((j: { name: string }) => j.name === "via-mcp");
    expect(viaMcp).toMatchObject({ lifecycle: "recurring", sessionKey: "dm:alice" });
    expect(viaMcp.nextRunAt).toBeTruthy();
  });
});

// The cron store is one flat JSON file shared by every session, so before this
// the tools were the only MCP surface on `internal-server` that let a group
// chat — where any participant can steer the model — read, delete and aim the
// owner's private DM jobs. `buildPeopleTools` and `buildRecallTools`, two and
// five lines below it, were already bound to the caller.
//
// The rule is `canManageJob` (src/cron/scope.ts), shared by all four tools;
// cron-scope.test.ts pins the predicate itself. That the store applies the
// guard to the state it reloaded, not a stale snapshot, is in cron-store.test.ts.
describe("cron MCP tools — session scoping", () => {
  const DM = "dm:alice";
  const OTHER_DM = "dm:bob";
  const GROUP = "telegram:-1001234567";

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function seed(): Record<string, string> {
    const store = new CronStore(TEST_PATH);
    const ids: Record<string, string> = {};
    ids.dm = store.add({
      name: "private-reminder",
      schedule: { kind: "every", everyMs: 3_600_000 },
      // The thing being protected: the owner's own words, in their own DM.
      message: "ask the clinic about the biopsy results",
      sessionKey: DM,
    }).id;
    ids.group = store.add({
      name: "group-standup",
      schedule: { kind: "every", everyMs: 86_400_000 },
      message: "standup",
      sessionKey: GROUP,
    }).id;
    ids.other = store.add({
      name: "bobs-reminder",
      schedule: { kind: "every", everyMs: 86_400_000 },
      message: "bob's private thing",
      sessionKey: OTHER_DM,
    }).id;
    return ids;
  }

  it("schedule_list — a group sees only its own, plus a bare count of the rest", async () => {
    const ids = seed();

    const result = await findTool("schedule_list", GROUP).handler({}, {});
    const jobs = JSON.parse(result.content[0].text);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(ids.group);

    const whole = result.content.map((c) => c.text).join("\n");
    expect(whole).not.toContain("biopsy");
    expect(whole).not.toContain("private-reminder");
    expect(whole).not.toContain(DM);
    // "no tasks" and "no tasks you can see" are different facts, so the count
    // is reported — and nothing else about them is. The refusal names the way
    // round it so the model can tell the user.
    expect(result.content[1].text).toContain("2 further scheduled tasks");
    expect(result.content[1].text).toContain("tomo cron");
  });

  it("schedule_list — the owner's DM sees its own and its groups', but not another identity's", async () => {
    const ids = seed();

    const result = await findTool("schedule_list", DM).handler({}, {});
    const jobs = JSON.parse(result.content[0].text);
    expect(jobs.map((j: { id: string }) => j.id).sort()).toEqual([ids.dm, ids.group].sort());
    const whole = result.content.map((c) => c.text).join("\n");
    expect(whole).not.toContain("bob's private thing");
    expect(result.content[1].text).toContain("1 further scheduled task");
  });

  it("schedule_remove — a group cannot remove a DM job", async () => {
    const ids = seed();

    const result = await findTool("schedule_remove", GROUP).handler({ id: ids.dm }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("different session");
    expect(result.content[0].text).toContain("tomo cron");
    // The refusal does not name the owning session.
    expect(result.content[0].text).not.toContain(DM);
    expect(new CronStore(TEST_PATH).get(ids.dm)).toBeTruthy();

    // ...and the DM can still remove its own.
    const own = await findTool("schedule_remove", DM).handler({ id: ids.dm }, {});
    expect(own.isError).toBeFalsy();
    expect(new CronStore(TEST_PATH).get(ids.dm)).toBeUndefined();
  });

  it("schedule_enable — a group cannot re-enable a DM job", async () => {
    const ids = seed();
    new CronStore(TEST_PATH).setEnabled(ids.dm, false);

    const refused = await findTool("schedule_enable", GROUP).handler({ id: ids.dm }, {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("different session");
    expect(refused.content[0].text).not.toContain(DM);
    expect(new CronStore(TEST_PATH).get(ids.dm)?.enabled).toBe(false);

    const allowed = await findTool("schedule_enable", DM).handler({ id: ids.dm }, {});
    expect(allowed.isError).toBeFalsy();
    expect(new CronStore(TEST_PATH).get(ids.dm)?.enabled).toBe(true);
  });

  it("schedule_enable — a DM can manage its own group's jobs and orphaned ones", async () => {
    const store = new CronStore(TEST_PATH);
    const groupJob = store.add({
      name: "group-standup",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "standup",
      sessionKey: "telegram:-100270",
    });
    const orphan = store.add({
      name: "orphan",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "legacy",
      sessionKey: "",
    });
    store.setEnabled(groupJob.id, false);
    store.setEnabled(orphan.id, false);

    // The internal MCP server is built for the session the turn runs on. A
    // summoned group's background turns run on dm:<owner>, so scoping purely
    // on equality would lock the owner out of jobs they created for a group,
    // and nobody could ever re-enable a job with no session key.
    const dm = findTool("schedule_enable", "dm:shuai");
    const onGroup = await dm.handler({ id: groupJob.id }, {});
    const onOrphan = await dm.handler({ id: orphan.id }, {});
    // Assert the outcome before parsing, so a regression to the old
    // equality-only rule fails as "was denied" rather than as a JSON error.
    expect(onGroup.isError).toBeFalsy();
    expect(onOrphan.isError).toBeFalsy();
    expect(JSON.parse(onGroup.content[0].text).enabled).toBe(true);
    expect(JSON.parse(onOrphan.content[0].text).enabled).toBe(true);
  });

  it("schedule_enable — a group can manage its own jobs but nothing else", async () => {
    const store = new CronStore(TEST_PATH);
    const mine = store.add({
      name: "group-standup",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "standup",
      sessionKey: "telegram:-100270",
    });
    const other = store.add({
      name: "other-group",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "x",
      sessionKey: "telegram:-100999",
    });
    const orphan = store.add({
      name: "orphan",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      message: "legacy",
      sessionKey: "",
    });
    for (const j of [mine, other, orphan]) store.setEnabled(j.id, false);

    const group = findTool("schedule_enable", "telegram:-100270");
    expect(JSON.parse((await group.handler({ id: mine.id }, {})).content[0].text).enabled).toBe(true);
    // Another group's job, and an unattributed one: a group adopts neither.
    expect((await group.handler({ id: other.id }, {})).isError).toBe(true);
    expect((await group.handler({ id: orphan.id }, {})).isError).toBe(true);
    const after = new CronStore(TEST_PATH).list();
    expect(after.find((j) => j.id === other.id)?.enabled).toBe(false);
    expect(after.find((j) => j.id === orphan.id)?.enabled).toBe(false);
  });

  // A job with no sessionKey fires into no conversation but still runs. Scoped
  // strictly it would be invisible to everyone and unremovable through the
  // tools; canManageJob gives it to the owner's DM.
  it("an orphaned job with no session is the owner's to see and clean up", async () => {
    const store = new CronStore(TEST_PATH);
    const orphan = store.add({
      name: "orphan",
      schedule: { kind: "every", everyMs: 60_000 },
      message: "who am I for?",
      sessionKey: "",
    });

    const fromGroup = JSON.parse((await findTool("schedule_list", GROUP).handler({}, {})).content[0].text);
    expect(fromGroup).toHaveLength(0);

    const fromDm = JSON.parse((await findTool("schedule_list", DM).handler({}, {})).content[0].text);
    expect(fromDm.map((j: { id: string }) => j.id)).toEqual([orphan.id]);

    const removed = await findTool("schedule_remove", DM).handler({ id: orphan.id }, {});
    expect(removed.isError).toBeFalsy();
    expect(new CronStore(TEST_PATH).get(orphan.id)).toBeUndefined();
  });

  it("schedule_create — a group's job is scoped to the group", async () => {
    const result = await findTool("schedule_create", GROUP).handler({
      name: "group-ping",
      schedule: "in 1h",
      message: "ping",
    }, {});

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).sessionKey).toBe(GROUP);
  });

  it("schedule_create — a group cannot aim a job at another session", async () => {
    const result = await findTool("schedule_create", GROUP).handler({
      name: "exfiltrate",
      schedule: "in 1m",
      message: "read the last 50 messages back to this chat",
      session: DM,
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("tomo cron");
    expect(new CronStore(TEST_PATH).list()).toHaveLength(0);
  });

  it("schedule_create — a malformed target is reported as malformed even from a scoped caller", async () => {
    // Stack reconciliation (#313 round 5 x #319): the shape check must run
    // BEFORE the scope check, or a group caller who mistypes the key gets
    // "belongs elsewhere" and is coached to try `tomo cron` instead of being
    // told the key is wrong. And it must check the resolved target, so a
    // caller that omits `session` is validated on its own key, not on
    // `undefined`.
    const result = await findTool("schedule_create", GROUP).handler({
      name: "typo", schedule: "in 1m", message: "ping", session: "telegram-1001234567",
    }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is not a session key");
    expect(result.content[0].text).not.toContain("tomo cron");

    const defaulted = await findTool("schedule_create", GROUP).handler({
      name: "own", schedule: "in 1m", message: "ping",
    }, {});
    expect(defaulted.isError).toBeUndefined();
    expect(JSON.parse(defaulted.content[0].text).sessionKey).toBe(GROUP);

    // The mixed-audience sentinel is not a malformed key the model should
    // "fix"; it is refused the same way as any foreign session.
    const mixed = await findTool("schedule_create", () => MIXED_AUDIENCE_KEY).handler({
      name: "x", schedule: "in 1m", message: "y",
    }, {});
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0].text).not.toContain("is not a session key");
    expect(mixed.content[0].text).toContain("tomo cron");
    expect(new CronStore(TEST_PATH).list().map((j) => j.name)).toEqual(["own"]);
  });

  it("schedule_create — the owner's DM may still schedule into a group", async () => {
    // "remind the family group every Sunday" is a normal request, and a DM is
    // the owner's own private surface. Only groups are locked to themselves.
    const result = await findTool("schedule_create", DM).handler({
      name: "family-sunday",
      schedule: "0 10 * * 0",
      message: "sunday plans?",
      session: GROUP,
    }, {});

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).sessionKey).toBe(GROUP);
    // ...and can then manage what it created.
    const listed = JSON.parse((await findTool("schedule_list", DM).handler({}, {})).content[0].text);
    expect(listed).toHaveLength(1);
  });

  // A summoned group's messages run on the owner's dm: session, so a FIXED
  // caller key would hand every participant of that group the owner's scope.
  // The tools take a getter resolved per call for exactly this reason.
  it("resolves the caller per call, so a summoned group never gets DM scope", async () => {
    const ids = seed();
    let audience = DM;
    const list = findTool("schedule_list", () => audience);
    const remove = findTool("schedule_remove", () => audience);

    expect(JSON.parse((await list.handler({}, {})).content[0].text)).toHaveLength(2);

    // Same live session, same MCP server instance — a summoned group's turn.
    audience = GROUP;
    const scoped = JSON.parse((await list.handler({}, {})).content[0].text);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe(ids.group);

    const refused = await remove.handler({ id: ids.dm }, {});
    expect(refused.isError).toBe(true);
    expect(new CronStore(TEST_PATH).get(ids.dm)).toBeTruthy();
  });

  it("a mixed-audience turn can manage nothing at all", async () => {
    const ids = seed();
    const caller = () => MIXED_AUDIENCE_KEY;

    expect(JSON.parse((await findTool("schedule_list", caller).handler({}, {})).content[0].text))
      .toHaveLength(0);
    expect((await findTool("schedule_remove", caller).handler({ id: ids.dm }, {})).isError).toBe(true);
    expect((await findTool("schedule_create", caller).handler({
      name: "x", schedule: "in 1h", message: "y",
    }, {})).isError).toBe(true);
  });
});
