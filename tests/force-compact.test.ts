import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { sdkSessionsDirForWorkspace } from "../src/runtime-paths.js";
import { getCompactTriggerPath } from "../src/lcm/compact.js";
import { computeContextStats, estimateTokens } from "../src/lcm/stats.js";
import {
  forceArchivePlaceholder, forceCompactSession, renderEventForSummary, selectOldestStretch, summaryRejection, type StretchForSummary,
} from "../src/lcm/force-compact.js";
import { capStaleUsage, capStaleUsageInFile, cliAnchorUsage } from "../src/lcm/stale-usage.js";

/**
 * The disk half of a forced compaction against the INSTALLED SDK's loader
 * (the same chain check every LCM rewrite goes through), with a scripted
 * summary function in place of the model call.
 */

let root: string;
let workspace: string;
let sdkSessionsDir: string;
let sessionsDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-force-compact-")));
  const home = join(root, "home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  sdkSessionsDir = sdkSessionsDirForWorkspace(workspace, home);
  mkdirSync(sdkSessionsDir, { recursive: true });
  sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const DAY = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m, 0).toISOString();

interface Built { sessionId: string; uuidsByDay: Map<number, string[]>; lastAssistantUuid: string }

/**
 * Three days of conversation (Nov 22–24), each `perDay` exchanges of ~`chars`
 * characters; a tool round inside day 22; the last assistant reply carries a
 * huge stale usage reading (the 11/25 shape). Optional giant tool result in
 * the last day.
 */
function build(opts: { perDay?: number; chars?: number; giantToolResult?: number; usage?: number } = {}): Built {
  const sessionId = randomUUID();
  const perDay = opts.perDay ?? 6;
  const chars = opts.chars ?? 2000;
  const envelope = { isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd: workspace, sessionId, version: "2.1.330", gitBranch: "main" };
  const lines: string[] = [];
  const uuidsByDay = new Map<number, string[]>();
  let parent: string | null = null;
  let n = 0;
  let lastAssistantUuid = "";
  const push = (type: "user" | "assistant", day: number, minute: number, content: unknown, usage?: Record<string, unknown>) => {
    const uuid = randomUUID();
    n++;
    lines.push(JSON.stringify({
      parentUuid: parent, ...envelope, type, uuid, timestamp: DAY(day, 9, minute),
      message: type === "assistant"
        ? { model: "claude-opus-5-5", id: `msg_${n}`, type: "message", role: "assistant", content, stop_reason: "end_turn", usage: usage ?? { input_tokens: 100, output_tokens: 10 } }
        : { role: "user", content },
    }));
    parent = uuid;
    uuidsByDay.set(day, [...(uuidsByDay.get(day) ?? []), uuid]);
    if (type === "assistant") lastAssistantUuid = uuid;
    return uuid;
  };
  const filler = (tag: string) => `${tag} ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(chars / 27))}`.slice(0, chars);
  for (const day of [22, 23, 24]) {
    for (let i = 0; i < perDay; i++) {
      push("user", day, i * 2, [{ type: "text", text: filler(`[telegram · day ${day} #${i}] question`) }]);
      if (day === 22 && i === 1) {
        push("assistant", day, i * 2, [{ type: "tool_use", id: `toolu_${day}_${i}`, name: "Bash", input: { command: "ls" } }]);
        push("user", day, i * 2, [{ type: "tool_result", tool_use_id: `toolu_${day}_${i}`, content: "a\nb\nc" }]);
      }
      if (day === 24 && i === perDay - 1 && opts.giantToolResult) {
        push("assistant", day, i * 2 + 1, [{ type: "tool_use", id: "toolu_giant", name: "Read", input: { file_path: "/big" } }]);
        push("user", day, i * 2 + 1, [{ type: "tool_result", tool_use_id: "toolu_giant", content: "x".repeat(opts.giantToolResult) }]);
      }
      const last = day === 24 && i === perDay - 1;
      push("assistant", day, i * 2 + 1, [{ type: "text", text: filler(`answer day ${day} #${i}`) }],
        last && opts.usage ? { input_tokens: 3, cache_read_input_tokens: opts.usage, cache_creation_input_tokens: 0, output_tokens: 200, iterations: [{ type: "message", input_tokens: 3, cache_read_input_tokens: opts.usage, cache_creation_input_tokens: 0, output_tokens: 200 }] } : undefined);
    }
  }
  writeFileSync(getSdkSessionPath(sessionId, sdkSessionsDir), lines.join("\n") + "\n");
  return { sessionId, uuidsByDay, lastAssistantUuid };
}

const fileEvents = (sessionId: string) => readFileSync(getSdkSessionPath(sessionId, sdkSessionsDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const chain = async (sessionId: string) => (await getSessionMessages(sessionId, { dir: workspace })).map((m) => m.uuid);
const estimate = (sessionId: string) => computeContextStats(sessionId, sdkSessionsDir)!.totalTokens;

/** A window that puts `contextUsed` (content + 2000 overhead) at `pct` %. */
function windowAt(sessionId: string, pct: number) {
  const contextUsed = estimate(sessionId) + 2000;
  return { contextUsed, contextMax: Math.ceil(contextUsed / (pct / 100)) };
}

describe("stale usage cap (the CLI's local window check)", () => {
  it("reads the newest real assistant usage the way the CLI does: iterations, skip zero and synthetic, stop at a boundary", () => {
    const a = (usage: unknown, model = "claude-opus-5-5") => ({ type: "assistant", message: { model, usage } });
    expect(cliAnchorUsage([a({ input_tokens: 10, output_tokens: 1 }), a({ input_tokens: 0, output_tokens: 0 })])).toBe(11);
    expect(cliAnchorUsage([a({ input_tokens: 10, output_tokens: 1 }), a({ input_tokens: 999, output_tokens: 1 }, "<synthetic>")])).toBe(11);
    expect(cliAnchorUsage([a({ input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 1, iterations: [{ type: "message", input_tokens: 1, cache_read_input_tokens: 970_000, cache_creation_input_tokens: 0, output_tokens: 6 }] })])).toBe(970_007);
    expect(cliAnchorUsage([a({ input_tokens: 10, output_tokens: 1 }), { type: "system", subtype: "compact_boundary" }])).toBe(0);
    expect(cliAnchorUsage([{ type: "user", message: { content: "x" } }])).toBeUndefined();
  });

  it("caps every reading above the ceiling (zeroing would only fall through to the next stale one)", () => {
    const entries = [
      { type: "assistant", uuid: "a", message: { model: "m", usage: { input_tokens: 1, cache_read_input_tokens: 960_000, output_tokens: 100 } } },
      { type: "assistant", uuid: "b", message: { model: "m", usage: { input_tokens: 2, cache_read_input_tokens: 977_000, output_tokens: 300, iterations: [{ type: "message", input_tokens: 2, cache_read_input_tokens: 977_000, cache_creation_input_tokens: 0, output_tokens: 300 }] } } },
      { type: "assistant", uuid: "c", message: { model: "m", usage: { input_tokens: 50, output_tokens: 5 } } },
    ] as never[];
    expect(cliAnchorUsage(entries)).toBe(55);
    const zeroed = structuredClone(entries) as Array<{ message: { usage: Record<string, number> } }>;
    zeroed[2].message.usage = { input_tokens: 0, output_tokens: 0 };
    zeroed[1].message.usage = { input_tokens: 0, output_tokens: 0 } as never;
    expect(cliAnchorUsage(zeroed as never)).toBe(960_101); // why zeroing is not a fix
    const capped = capStaleUsage(entries, 50_000);
    expect(capped).toBe(2);
    expect(cliAnchorUsage(entries.slice(0, 2))).toBeLessThanOrEqual(50_000);
    const b = (entries[1] as { message: { usage: Record<string, unknown> }; tomoUsageCapped?: { from: number } });
    expect(b.message.usage.iterations).toBeUndefined();
    expect(b.tomoUsageCapped?.from).toBe(977_302);
    expect((entries[2] as { message: { usage: Record<string, number> } }).message.usage.input_tokens).toBe(50);
  });

  it("rewrites the file with only usage changed (the loader's chain is identical)", async () => {
    const b = build({ usage: 977_000 });
    const before = await chain(b.sessionId);
    expect(cliAnchorUsage(fileEvents(b.sessionId))).toBe(977_203);
    const r = capStaleUsageInFile({ sdkSessionId: b.sessionId, sdkSessionsDir, overhead: 2_000 });
    expect(r).toEqual({ success: true, capped: 1 });
    expect(cliAnchorUsage(fileEvents(b.sessionId))).toBe(2_000 + estimate(b.sessionId));
    expect(await chain(b.sessionId)).toEqual(before);
    expect(capStaleUsageInFile({ sdkSessionId: b.sessionId, sdkSessionsDir, overhead: 2_000 })).toEqual({ success: true, capped: 0 });
  });

  it("caps the anchor at what the context held THROUGH it: the CLI adds the tail after it itself", () => {
    const b = build({ usage: 977_000 });
    const path = getSdkSessionPath(b.sessionId, sdkSessionsDir);
    const events = fileEvents(b.sessionId);
    const tail = { ...events.find((e) => e.type === "user"), uuid: randomUUID(), parentUuid: events.at(-1).uuid, timestamp: DAY(24, 23, 0), message: { role: "user", content: "x".repeat(40_000) } };
    writeFileSync(path, [...events, tail].map((e) => JSON.stringify(e)).join("\n") + "\n");
    capStaleUsageInFile({ sdkSessionId: b.sessionId, sdkSessionsDir, overhead: 2_000 });
    const after = fileEvents(b.sessionId);
    const anchor = cliAnchorUsage(after)!;
    const tailTokens = estimateTokens("x".repeat(40_000));
    expect(anchor).toBe(2_000 + estimate(b.sessionId) - tailTokens);
    // What the CLI checks — anchor + its estimate of what follows — is the whole conversation once, not the tail twice.
    expect(anchor + tailTokens).toBe(2_000 + estimate(b.sessionId));
  });
});

describe("selectOldestStretch", () => {
  it("takes the oldest whole day, outside the fresh tail", () => {
    const b = build();
    const s = selectOldestStretch(fileEvents(b.sessionId), { freshTail: 4, maxInputTokens: 150_000 })!;
    expect(s.blockTag).toBe("daily 2026-11-22");
    expect(s.label).toBe("whole day 2026-11-22");
    expect(s.firstUuid).toBe(b.uuidsByDay.get(22)![0]);
    expect(s.lastUuid).toBe(b.uuidsByDay.get(22)!.at(-1));
    expect(s.text).toContain("day 22 #0");
    expect(s.text).not.toContain("day 23");
  });

  it("cuts a day over the input cap to a prefix, never right before a tool result", () => {
    const b = build({ chars: 4000 });
    const events = fileEvents(b.sessionId);
    const conv = events.filter((e) => e.type === "user" || e.type === "assistant");
    const callAt = conv.findIndex((e) => JSON.stringify(e.message.content).includes("tool_use"));
    // A cap that ends the stretch exactly on the tool call: its result would be left behind, orphaned.
    const cap = conv.slice(0, callAt + 1).reduce((sum, e) => sum + estimateTokens(renderEventForSummary(e)), 0);
    const s = selectOldestStretch(events, { freshTail: 4, maxInputTokens: cap })!;
    expect(s.label).toBe("part of 2026-11-22");
    expect(s.lastUuid).not.toBe(conv[callAt].uuid);
    expect(s.lastUuid).toBe(conv[callAt - 1].uuid);
    const kept = events.slice(events.findIndex((e) => e.uuid === s.lastUuid) + 1).find((e) => e.type === "user" || e.type === "assistant");
    expect(JSON.stringify(kept.message.content)).not.toContain("tool_result");
  });

  it("stops before an unrelated summary block, and merges the same day's own block", () => {
    const b = build({ perDay: 2 });
    const events = fileEvents(b.sessionId);
    const firstOf23 = events.findIndex((e) => e.uuid === b.uuidsByDay.get(23)![0]);
    events.splice(firstOf23, 0, { type: "user", uuid: "blk", isCompactSummary: true, blockTag: "weekly 2026-W47", timestamp: DAY(23, 0, 0), message: { role: "user", content: "[weekly]" } });
    const s = selectOldestStretch(events, { freshTail: 1, maxInputTokens: 150_000 })!;
    expect(s.blockTag).toBe("daily 2026-11-22");
    expect(s.text).not.toContain("[weekly]");

    const own = fileEvents(b.sessionId);
    own.unshift({ type: "user", uuid: "own", isCompactSummary: true, blockTag: "daily 2026-11-22", timestamp: DAY(22, 8, 0), message: { role: "user", content: "[daily 2026-11-22 — 9 events summarized]\n\nMorning: decided X." } });
    const s2 = selectOldestStretch(own, { freshTail: 1, maxInputTokens: 150_000 })!;
    expect(s2.existingBlock).toBe("Morning: decided X.");
    expect(s2.text).toContain("Morning: decided X.");
  });

  it("takes only a run of raw events: stops at any block, and never tags it so a later same-day block is absorbed", () => {
    const b = build({ chars: 4000 });
    const events = fileEvents(b.sessionId);
    const day22 = b.uuidsByDay.get(22)!;
    const at = events.findIndex((e) => e.uuid === day22[6]);
    events.splice(at, 0,
      { type: "user", uuid: "wk", isCompactSummary: true, blockTag: "weekly 2026-W47", timestamp: DAY(22, 12, 0), message: { role: "user", content: "[weekly]\n\nWEEKLY-TEXT" } },
      { type: "user", uuid: "late", isCompactSummary: true, blockTag: "daily 2026-11-22", timestamp: DAY(22, 12, 1), message: { role: "user", content: "[daily]\n\nevening" } });
    const s = selectOldestStretch(events, { freshTail: 4, maxInputTokens: 150_000 })!;
    const range = events.filter((e) => e.type === "user" || e.type === "assistant").slice(s.fromConv, s.toConv + 1);
    expect(range.some((e) => e.isCompactSummary)).toBe(false);
    expect(s.lastUuid).toBe(day22[5]);
    // The day's own block sits after the run: the day's tag would make the rewrite absorb it (and the weekly between).
    expect(s.blockTag).toBeUndefined();
    expect(s.text).not.toContain("WEEKLY-TEXT");
  });

  it("does not end a run on a tool call whose result sits behind a summary block", () => {
    const b = build({ chars: 4000 });
    const events = fileEvents(b.sessionId);
    const resultAt = events.findIndex((e) => JSON.stringify(e.message?.content ?? "").includes("tool_result"));
    events.splice(resultAt, 0, { type: "user", uuid: "blk", isCompactSummary: true, blockTag: "weekly 2026-W47", timestamp: DAY(22, 9, 2), message: { role: "user", content: "[weekly]" } });
    const s = selectOldestStretch(events, { freshTail: 4, maxInputTokens: 150_000 });
    const call = events[resultAt - 1];
    expect(JSON.stringify(call.message.content)).toContain("tool_use");
    expect(s?.lastUuid).not.toBe(call.uuid);
  });

  it("skips an uncuttable oldest run (call | block | result) and takes the next safe one", () => {
    const b = build({ chars: 4000 });
    const all = fileEvents(b.sessionId);
    const resultAt = all.findIndex((e) => JSON.stringify(e.message?.content ?? "").includes("tool_result"));
    const events = all.slice(resultAt - 1);
    events.splice(1, 0, { type: "user", uuid: "blk", isCompactSummary: true, blockTag: "weekly 2026-W47", timestamp: DAY(22, 9, 2), message: { role: "user", content: "[weekly]" } });
    const s = selectOldestStretch(events, { freshTail: 4, maxInputTokens: 150_000 })!;
    expect(s).not.toBeNull();
    const firstAt = events.findIndex((e) => e.uuid === s.firstUuid);
    expect(firstAt).toBeGreaterThan(2);
  });

  it("starts on a turn boundary, never on a leftover tool result", () => {
    const b = build();
    const events = fileEvents(b.sessionId);
    const resultAt = events.findIndex((e) => JSON.stringify(e.message?.content ?? "").includes("tool_result"));
    const s = selectOldestStretch(events.slice(resultAt), { freshTail: 4, maxInputTokens: 150_000 })!;
    expect(s.firstUuid).not.toBe(events[resultAt].uuid);
  });

  it("starts after the last SDK compact boundary (nothing before it is on the chain)", () => {
    const b = build({ perDay: 2 });
    const events = fileEvents(b.sessionId);
    const at = events.findIndex((e) => e.uuid === b.uuidsByDay.get(23)![0]);
    events.splice(at, 0, { type: "system", subtype: "compact_boundary", uuid: "bnd", timestamp: DAY(23, 0, 0) });
    expect(selectOldestStretch(events, { freshTail: 1, maxInputTokens: 150_000 })!.blockTag).toBe("daily 2026-11-23");
  });

  it("refuses a summary that is empty, an error, or far too long", () => {
    expect(summaryRejection("")).toMatch(/empty/);
    expect(summaryRejection("Prompt is too long")).toMatch(/short|error/);
    expect(summaryRejection("API Error: 529 overloaded — the summary model is unavailable right now, try later")).toMatch(/error/);
    expect(summaryRejection("x ".repeat(40_000))).toMatch(/over/);
    expect(summaryRejection("2026-11-22: owner asked about the release; decided to ship Friday.")).toBeNull();
  });
});

describe("forceCompactSession", () => {
  const common = () => ({ sdkSessionsDir, sessionsDir, workspaceDir: workspace, freshTail: 4 });

  it("stops after prune when that alone gets under the safe line (no model call)", async () => {
    const b = build({ giantToolResult: 200_000, usage: 977_000 });
    const w = windowAt(b.sessionId, 96);
    const summarize = vi.fn(async () => "never");
    const r = await forceCompactSession({ ...common(), sdkSessionId: b.sessionId, ...w, summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(r.pruned?.entries).toBeGreaterThan(0);
    expect(r.reachedSafe).toBe(true);
    expect(r.summarized).toEqual([]);
    // ⑤ also after a prune-only run: the stale reading is capped, at the estimate of what is left.
    expect(cliAnchorUsage(fileEvents(b.sessionId))).toBe(r.afterTokens);
    expect(r.afterTokens).toBeLessThanOrEqual(Math.floor(w.contextMax * 0.7));
    expect(existsSync(getCompactTriggerPath(b.sessionId, sdkSessionsDir))).toBe(false);
  });

  it("summarizes the oldest day with a separate call fed only that day, through the checked rewrite", async () => {
    const b = build({ usage: 977_000 });
    const w = windowAt(b.sessionId, 96);
    const before = await chain(b.sessionId);
    const seen: StretchForSummary[] = [];
    const summarize = vi.fn(async (s: StretchForSummary) => { seen.push(s); return `Summary of ${s.from}–${s.to}: the owner asked questions; Tomo answered.`; });
    const r = await forceCompactSession({ ...common(), sdkSessionId: b.sessionId, ...w, summarize });

    expect(r.summarized.length).toBeGreaterThanOrEqual(1);
    expect(r.summarized[0].blockTag).toBe("daily 2026-11-22");
    expect(seen[0].text).toContain("day 22 #0");
    expect(seen[0].text).not.toContain("day 24");
    expect(r.reachedSafe).toBe(true);
    expect(r.archived).toEqual([]);

    const after = await chain(b.sessionId);
    const day22 = new Set(b.uuidsByDay.get(22));
    expect(after.some((u) => day22.has(u))).toBe(false);
    const block = fileEvents(b.sessionId).find((e) => e.isCompactSummary && e.blockTag === "daily 2026-11-22");
    // One round was enough here: the new block heads the chain, and the rest of it is intact, in order.
    expect(r.summarized).toHaveLength(1);
    expect(after).toEqual([block.uuid, ...before.filter((u) => !day22.has(u))]);
    expect(block.message.content).toContain("Forced compaction");
    expect(cliAnchorUsage(fileEvents(b.sessionId))).toBeLessThanOrEqual(Math.floor(w.contextMax * 0.7));
    // The originals are in the archive (searchable), the trigger is gone.
    expect(readFileSync(join(sessionsDir, `_archive_${b.sessionId}.jsonl`), "utf8")).toContain("day 22 #0");
    expect(existsSync(getCompactTriggerPath(b.sessionId, sdkSessionsDir))).toBe(false);
  });

  it.each([
    ["the summary call throws", async () => { throw new Error("529 overloaded"); }],
    ["the summary is empty", async () => ""],
  ])("archives the stretch with a placeholder when %s", async (_label, impl) => {
    const b = build();
    const w = windowAt(b.sessionId, 96);
    const r = await forceCompactSession({ ...common(), sdkSessionId: b.sessionId, ...w, summarize: vi.fn(impl), maxRounds: 1 });
    expect(r.summarized).toEqual([]);
    expect(r.archived).toHaveLength(1);
    const block = fileEvents(b.sessionId).find((e) => e.isCompactSummary && e.blockTag === "daily 2026-11-22");
    expect(block.message.content).toContain("[force-archived");
    expect(block.message.content).toContain("tomo lcm search");
    expect(readFileSync(join(sessionsDir, `_archive_${b.sessionId}.jsonl`), "utf8")).toContain("day 22 #0");
    expect((await chain(b.sessionId))[0]).toBe(block.uuid);
  });

  it("fails closed when the chain check refuses: no block, nothing archived", async () => {
    const b = build({ usage: 977_000 });
    const w = windowAt(b.sessionId, 96);
    const original = readFileSync(getSdkSessionPath(b.sessionId, sdkSessionsDir), "utf8");
    const r = await forceCompactSession({
      ...common(), sdkSessionId: b.sessionId, ...w,
      summarize: async () => "A perfectly good summary of the day, long enough to pass.",
      loadChain: async () => { throw new Error("loader broke"); },
    });
    expect(r.summarized).toEqual([]);
    expect(r.archived).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/archive rewrite/);
    // Not even the usage cap: that would only hide a session still too big from the CLI's check.
    expect(r.usageCapped).toBe(0);
    expect(r.ok).toBe(false);
    expect(readFileSync(getSdkSessionPath(b.sessionId, sdkSessionsDir), "utf8")).toBe(original);
  });

  it("caps at the honest estimate of what is left, and does nothing once shutdown has begun", async () => {
    const b = build({ usage: 977_000 });
    const w = windowAt(b.sessionId, 96);
    const r = await forceCompactSession({ ...common(), sdkSessionId: b.sessionId, ...w, summarize: async () => "Summary: the owner asked; Tomo answered; nothing open.", maxRounds: 1, safePct: 10 });
    expect(r.ok).toBe(true);
    expect(r.reachedSafe).toBe(false);
    expect(cliAnchorUsage(fileEvents(b.sessionId))).toBe(r.afterTokens);

    const c = build({ usage: 977_000 });
    const original = readFileSync(getSdkSessionPath(c.sessionId, sdkSessionsDir), "utf8");
    const ac = new AbortController();
    ac.abort();
    const summarize = vi.fn(async () => "never");
    const r2 = await forceCompactSession({ ...common(), sdkSessionId: c.sessionId, ...windowAt(c.sessionId, 96), summarize, signal: ac.signal });
    expect(summarize).not.toHaveBeenCalled();
    expect(r2.ok).toBe(false);
    expect(readFileSync(getSdkSessionPath(c.sessionId, sdkSessionsDir), "utf8")).toBe(original);
  });

  it("estimates the active chain only (nothing before an SDK compact boundary), and calls a run that changed nothing a failure", async () => {
    const b = build({ perDay: 2 });
    const path = getSdkSessionPath(b.sessionId, sdkSessionsDir);
    const events = fileEvents(b.sessionId);
    // Everything so far sits before a boundary; after it, one small exchange.
    const boundary = { type: "system", subtype: "compact_boundary", uuid: randomUUID(), parentUuid: null, timestamp: DAY(25, 9, 0), sessionId: b.sessionId };
    const u = { ...events[0], uuid: randomUUID(), parentUuid: boundary.uuid, timestamp: DAY(25, 9, 1), message: { role: "user", content: "hi" } };
    writeFileSync(path, [...events, boundary, u].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const summarize = vi.fn(async () => "never");
    const r = await forceCompactSession({ ...common(), sdkSessionId: b.sessionId, contextMax: 100_000, summarize });
    expect(r.afterTokens).toBeLessThan(25_000); // default overhead + the active chain, not the whole file
    expect(summarize).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("nothing could be compacted");
  });

  it("writes the placeholder line the brief asks for", () => {
    expect(forceArchivePlaceholder({ events: 12, from: "2026-11-22 09:00", to: "2026-11-22 18:00" }))
      .toBe("[force-archived 12 events from 2026-11-22 09:00 to 2026-11-22 18:00; use `tomo lcm search` to recall]");
  });
});
