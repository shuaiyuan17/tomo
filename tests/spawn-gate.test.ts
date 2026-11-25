import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { spawnDenial, launchesBackgroundSubagent, spawnGateEnabled } = await import("../src/agent/spawn-gate.js");
const { backgroundLaunchGuardHooks, CompactReservations } = await import("../src/agent/compact-reservations.js");
const { buildHooksOption } = await import("../src/agent/sdk-options.js");

const IDLE = { activeBackgroundTasks: 0, awaitingTaskReport: false, backgroundingInFlight: 0 };
const at = (pct: number) => ({ contextUsed: pct * 10, contextMax: 1000 });
type Hook = (input: { tool_name: string; tool_input: unknown }) => Promise<Record<string, unknown>>;

/** The installed PreToolUse hook, with the gate reading `reading` at `pct`. */
function gateHook(getReading: () => ReturnType<typeof at> | null, pct = 80, compactDenial: () => string | null = () => null): Hook {
  return backgroundLaunchGuardHooks("group:1", compactDenial, () => spawnDenial(getReading(), pct)).PreToolUse[0].hooks[0] as Hook;
}

describe("spawnDenial (the decision)", () => {
  it("denies at and over the threshold with the compact-first message, allows under it", () => {
    expect(spawnDenial(at(80), 80)).toContain("Context is at 80%: compact first (lcm compact / daily rollup), then start new background agents. Agents already running are unaffected");
    expect(spawnDenial(at(87), 80)).toContain("87%");
    expect(spawnDenial(at(79), 80)).toBeNull();
  });

  it("a session lcm does not compact gets a refusal that does not point at lcm", () => {
    const msg = spawnDenial(at(85), 80, false)!;
    expect(msg).toContain("85%");
    expect(msg).toContain("until this session is compacted");
    expect(msg).not.toContain("lcm");
  });

  it("0 and 100 turn it off", () => {
    expect(spawnDenial(at(99), 0)).toBeNull();
    expect(spawnDenial(at(99), 100)).toBeNull();
    expect(spawnGateEnabled(0)).toBe(false);
    expect(spawnGateEnabled(100)).toBe(false);
    expect(spawnGateEnabled(80)).toBe(true);
  });

  it("an unknown reading never blocks: none yet, no window, or estimated (as the nudger skips it)", () => {
    expect(spawnDenial(null, 80)).toBeNull();
    expect(spawnDenial({ contextUsed: 900, contextMax: 0 }, 80)).toBeNull();
    expect(spawnDenial({ contextUsed: 900, contextMax: 1000, contextEstimated: true }, 80)).toBeNull();
  });

  it("only a new background subagent launch is in scope", () => {
    expect(launchesBackgroundSubagent("Agent", { prompt: "x" })).toBe(true);
    expect(launchesBackgroundSubagent("Agent", { prompt: "x", run_in_background: true })).toBe(true);
    expect(launchesBackgroundSubagent("Task", { prompt: "x" })).toBe(true);
    expect(launchesBackgroundSubagent("Agent", { prompt: "x", run_in_background: false })).toBe(false);
    expect(launchesBackgroundSubagent("SendMessage", { to: "a1", message: "go on" })).toBe(false);
    expect(launchesBackgroundSubagent("Bash", { command: "tomo lcm compact", run_in_background: true })).toBe(false);
    expect(launchesBackgroundSubagent("mcp__tomo-internal__task_spawn", { brief: "x" })).toBe(false);
  });
});

describe("spawn gate hook", () => {
  it("at/over the threshold denies a background Agent launch, including one that omits run_in_background", async () => {
    const hook = gateHook(() => at(87));
    for (const input of [{ prompt: "x" }, { prompt: "x", run_in_background: true }]) {
      const out = await hook({ tool_name: "Agent", tool_input: input });
      expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
      expect((out.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason).toContain("87%");
    }
  });

  it("below the threshold allows it; it lifts live when usage drops (no latch)", async () => {
    let reading = at(90);
    const hook = gateHook(() => reading);
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x" } })).not.toEqual({});
    reading = at(40); // compacted
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x" } })).toEqual({});
  });

  it("never blocks SendMessage, a foreground Agent, task_spawn, or the compaction's own Bash", async () => {
    const hook = gateHook(() => at(99));
    expect(await hook({ tool_name: "SendMessage", tool_input: { to: "a1", message: "continue" } })).toEqual({});
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x", run_in_background: false } })).toEqual({});
    expect(await hook({ tool_name: "mcp__tomo-internal__task_spawn", tool_input: { brief: "x" } })).toEqual({});
    expect(await hook({ tool_name: "Bash", tool_input: { command: "tomo lcm daily --session-id s --summary x" } })).toEqual({});
    expect(await hook({ tool_name: "Skill", tool_input: { skill: "tomo-lcm" } })).toEqual({});
  });

  it("is off at 0 and 100", async () => {
    for (const pct of [0, 100]) {
      expect(await gateHook(() => at(99), pct)({ tool_name: "Agent", tool_input: { prompt: "x" } })).toEqual({});
    }
  });

  it("a spawn it refuses does not start the compact settle window (the compact it asks for can run at once)", async () => {
    const r = new CompactReservations(() => false);
    const hook = gateHook(() => at(90), 80, () => r.launchDenial("k"));
    expect(await hook({ tool_name: "Agent", tool_input: { prompt: "x" } })).not.toEqual({});
    expect(r.reserve("k", "sid", IDLE).ok).toBe(true);
    r.dispose();
  });

  it("is installed through the SDK options when a spawnDenial is given", async () => {
    const hooks = (buildHooksOption({ maxTurns: 0, spawnDenial: () => "full" }) as {
      hooks?: { PreToolUse?: { hooks: Hook[] }[] };
    }).hooks;
    const pre = hooks?.PreToolUse ?? [];
    expect(pre.length).toBeGreaterThan(0);
    const outs = await Promise.all(pre.flatMap((m) => m.hooks).map((h) => h({ tool_name: "Agent", tool_input: { prompt: "x" } })));
    expect(outs.some((o) => (o.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny")).toBe(true);
  });
});
