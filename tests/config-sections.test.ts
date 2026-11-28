import { describe, expect, it } from "vitest";
import { configLoader } from "./helpers/config-loader.js";

/**
 * One `describe` per config section that has its own parser and defaults.
 * Every load runs against a scratch HOME with the ambient env cleared
 * (tests/helpers/config-loader.ts), so nothing here reads the developer's
 * real ~/.tomo.
 */
const { load } = configLoader("tomo-config-sections-");

describe("effort", () => {
  it("is unset by default, leaving the level to the SDK", async () => {
    const { config, configIssues } = await load({});
    expect(config.effort).toBeNull();
    expect(config.sessionEffortOverrides).toEqual({});
    expect(configIssues.join("\n")).not.toContain("effort");
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("accepts the SDK level %s", async (level) => {
    const { config, configIssues } = await load({ effort: level });
    expect(config.effort).toBe(level);
    expect(configIssues.join("\n")).not.toContain("effort");
  });

  it("reports an invalid level instead of dropping it silently", async () => {
    const { config, configIssues } = await load({ effort: "ultra" });
    expect(config.effort).toBeNull();
    expect(configIssues.join("\n")).toMatch(/^effort: /m);
  });

  it("reads per-session overrides and rejects a bad level in them", async () => {
    const ok = await load({ sessionEffortOverrides: { "dm:owner": "low" } });
    expect(ok.config.sessionEffortOverrides).toEqual({ "dm:owner": "low" });

    const bad = await load({ sessionEffortOverrides: { "dm:owner": "turbo" } });
    expect(bad.config.sessionEffortOverrides).toEqual({});
    expect(bad.configIssues.join("\n")).toContain("sessionEffortOverrides");
  });
});

describe("interruptedAgents", () => {
  it("defaults to on, with auto-resume on", async () => {
    const { config } = await load({});
    expect([config.interruptedAgents, config.interruptedAgentsAutoResume]).toEqual([true, true]);
  });

  it("keeps the plain boolean form", async () => {
    const { config, configIssues } = await load({ interruptedAgents: false });
    expect([config.interruptedAgents, config.interruptedAgentsAutoResume]).toEqual([false, true]);
    expect(configIssues).toEqual([]);
  });

  it("reads the object form", async () => {
    const { config, configIssues } = await load({ interruptedAgents: { autoResume: false } });
    expect([config.interruptedAgents, config.interruptedAgentsAutoResume]).toEqual([true, false]);
    expect(configIssues).toEqual([]);
    const off = await load({ interruptedAgents: { enabled: false } });
    expect(off.config.interruptedAgents).toBe(false);
  });

  it("an env var overrides the file", async () => {
    const { config } = await load({ interruptedAgents: { autoResume: true } }, { TOMO_INTERRUPTED_AGENTS_AUTO_RESUME: "false" });
    expect(config.interruptedAgentsAutoResume).toBe(false);
  });
});

/**
 * The metrics block carries two privacy-relevant switches whose defaults are
 * `true`. A whole-object fallback on one bad field silently re-enables them,
 * so each field has to stand or fall on its own.
 */
describe("metrics", () => {
  it("keeps the other metrics fields when one field is invalid", async () => {
    const { config, configIssues } = await load({
      metrics: { enabled: true, port: "not-a-port", activityLog: true, includeMessageText: false },
    });

    // The whole-object fallback used to reset these to DEFAULT_METRICS, which
    // has includeMessageText: true — transcript text into activity.ndjson for
    // a user who explicitly opted out.
    expect(config.metrics.includeMessageText).toBe(false);
    expect(config.metrics.enabled).toBe(true);
    expect(config.metrics.activityLog).toBe(true);
    // Only the bad field falls back, and it is still reported.
    expect(config.metrics.port).toBe(9464);
    expect(configIssues.join("\n")).toContain("metrics.port");
  });

  it("still reports a metrics block that is not an object and uses defaults", async () => {
    const { config, configIssues } = await load({ metrics: "yes" });
    expect(configIssues.join("\n")).toContain("metrics:");
    expect(config.metrics).toEqual({
      enabled: false, port: 9464, activityLog: true, includeMessageText: true,
    });
  });

  it("parses a fully valid metrics block with no issues", async () => {
    const { config, configIssues } = await load({
      metrics: { enabled: true, port: 9999, activityLog: false, includeMessageText: false },
    });
    expect(configIssues).toEqual([]);
    expect(config.metrics).toEqual({
      enabled: true, port: 9999, activityLog: false, includeMessageText: false,
    });
  });
});

describe("subsessions", () => {
  it("is on by default, with the design's defaults", async () => {
    const { config, DEFAULT_SUBSESSIONS } = await load({});
    expect(config.subsessions).toEqual(DEFAULT_SUBSESSIONS);
    expect(config.subsessions.enabled).toBe(true);
    expect(DEFAULT_SUBSESSIONS).toEqual({ enabled: true, maxRunning: 2, maxOpen: 5, maxTurns: 200, maxContextTokens: 500_000, defaultModel: null, mirror: "turn", ownerMessages: "via-main", maxActiveHours: 24, quotaPauseAtPct: 85 });
  });

  it("takes a quota pause threshold, 0 < pct <= 100, a bad one falling back to 85", async () => {
    expect((await load({ subsessions: { quotaPauseAtPct: 70 } })).config.subsessions.quotaPauseAtPct).toBe(70);
    for (const bad of [0, 101, "high"]) {
      const out = await load({ subsessions: { quotaPauseAtPct: bad } });
      expect(out.config.subsessions.quotaPauseAtPct).toBe(85);
      expect(out.configIssues.join("\n")).toContain("subsessions.quotaPauseAtPct");
    }
  });

  it("sends a task's messages through the main session unless ownerMessages is direct", async () => {
    expect((await load({ subsessions: { ownerMessages: "direct" } })).config.subsessions.ownerMessages).toBe("direct");
    const bad = await load({ subsessions: { ownerMessages: "phone" } });
    expect(bad.config.subsessions.ownerMessages).toBe("via-main");
    expect(bad.configIssues.join("\n")).toContain("subsessions.ownerMessages");
  });

  it("can be turned off, and takes a wall-clock cap (0 = none)", async () => {
    const { config, configIssues } = await load({ subsessions: { enabled: false, maxActiveHours: 0 } });
    expect(config.subsessions).toMatchObject({ enabled: false, maxActiveHours: 0 });
    expect(configIssues.join("\n")).not.toContain("subsessions");
    const bad = await load({ subsessions: { maxActiveHours: -1 } });
    expect(bad.config.subsessions.maxActiveHours).toBe(24);
    expect(bad.configIssues.join("\n")).toContain("subsessions.maxActiveHours");
  });

  it("takes overrides and drops only a bad field", async () => {
    const { config, configIssues } = await load({ subsessions: { enabled: true, maxRunning: 0, defaultModel: "sonnet" } });
    expect(config.subsessions).toMatchObject({ enabled: true, maxRunning: 2, defaultModel: "sonnet" });
    expect(configIssues.join("\n")).toContain("subsessions.maxRunning");
  });

  it("takes the Phase 2 keys and refuses a bad mirror mode", async () => {
    // `todos` (sub-sessions once kept a todo each) is no longer a key: an old file that still has it loads without an issue.
    const { config, configIssues } = await load({ subsessions: { mirror: "lots", maxActiveHours: 0, todos: false } });
    expect(config.subsessions).toMatchObject({ mirror: "turn", maxActiveHours: 0 });
    expect(config.subsessions).not.toHaveProperty("todos");
    expect(configIssues.join("\n")).not.toContain("subsessions.todos");
    expect(configIssues.join("\n")).toContain("subsessions.mirror");
  });
});

describe("todos", () => {
  it("defaults every limit", async () => {
    const { config, DEFAULT_TODOS } = await load({});
    expect(config.todos).toEqual(DEFAULT_TODOS);
    expect(DEFAULT_TODOS).toEqual({
      maxOpen: 30, maxSnoozes: 3, titleMaxChars: 120, nextMaxChars: 200,
      reviewDaysSelf: 3, reviewDaysWaiting: 7, maxReviewDays: 90, dueMax: 3,
    });
  });

  it("takes overrides and drops only a bad field", async () => {
    const { config, configIssues } = await load({ todos: { maxOpen: 50, maxSnoozes: "lots", dueMax: 5 } });
    expect(config.todos.maxOpen).toBe(50);
    expect(config.todos.dueMax).toBe(5);
    expect(config.todos.maxSnoozes).toBe(3);
    expect(configIssues.join("\n")).toContain("todos.maxSnoozes");
  });
});

describe("memory", () => {
  it("enforces the store guard by default", async () => {
    const { config, configIssues } = await load({});
    expect(config.memory).toEqual({ storeGuard: "enforce" });
    expect(configIssues.join("\n")).not.toContain("memory");
  });

  it("takes warn and off", async () => {
    expect((await load({ memory: { storeGuard: "warn" } })).config.memory.storeGuard).toBe("warn");
    expect((await load({ memory: { storeGuard: "off" } })).config.memory.storeGuard).toBe("off");
  });

  it("reports a bad value and keeps enforcing", async () => {
    const { config, configIssues } = await load({ memory: { storeGuard: "loose" } });
    expect(config.memory.storeGuard).toBe("enforce");
    expect(configIssues.join("\n")).toContain("memory.storeGuard");
  });
});

/**
 * The credential broker asks for secrets over chat, so it is opt-in: a missing
 * block, and a block the loader cannot read, must both leave it OFF.
 */
describe("credentialBroker", () => {
  it("is off when the block is absent", async () => {
    const { config, configIssues } = await load({});
    expect(config.credentialBroker).toEqual({ enabled: false });
    expect(configIssues.join("\n")).not.toContain("credentialBroker");
  });

  it("stays off, and says so, when the block is malformed", async () => {
    const { config, configIssues } = await load({ credentialBroker: { enabled: "yes" } });
    expect(config.credentialBroker).toEqual({ enabled: false });
    expect(configIssues.join("\n")).toContain("credentialBroker");
  });

  it("turns on only for an explicit true", async () => {
    const { config, configIssues } = await load({ credentialBroker: { enabled: true } });
    expect(config.credentialBroker).toEqual({ enabled: true });
    expect(configIssues).toEqual([]);
  });
});
