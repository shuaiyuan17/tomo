import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_STARTED_FILE,
  readLedgerStarted,
  writeLedgerStarted,
  TRIGGER_MAX_CHARS,
  UsageLedger,
  ledgerFileName,
  triggerSnippet,
  usageCategory,
  type UsageLedgerRow,
} from "../src/usage/ledger.js";
import { formatTomoEvent } from "../src/tomo-event.js";
import { usageAttributionFor } from "../src/agent/turn-runner.js";

// The first row's write is slow, so an unserialized second write would land first.
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, appendFile: async (...args: Parameters<typeof real.appendFile>) => {
    if (String(args[1]).includes('"sessionKey":"slow-first"')) await new Promise((r) => setTimeout(r, 30));
    return real.appendFile(...args);
  } };
});
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { log } = await import("../src/logger.js");

const row = (ts: number, extra: Partial<UsageLedgerRow> = {}): UsageLedgerRow => ({
  v: 1, ts, sessionKey: "dm:owner", source: "owner", costUsd: 0.1,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreated: 4 }, ...extra,
});

describe("UsageLedger", () => {
  let dir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "tomo-usage-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends one JSON line per row to the file for the row's local month, creating the directory", async () => {
    const usageDir = join(dir, "data", "usage");
    const ledger = new UsageLedger(usageDir);
    const oct = new Date(2026, 9, 31, 23, 59).getTime();
    const nov = new Date(2026, 10, 1, 0, 1).getTime();
    await ledger.append(row(oct));
    await ledger.append(row(nov));
    await ledger.append(row(nov, { source: "cron", jobId: "j1" }));

    const read = (name: string) => readFileSync(join(usageDir, name), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(read("2026-10.ndjson")).toEqual([row(oct)]);
    expect(read("2026-11.ndjson")).toEqual([row(nov), row(nov, { source: "cron", jobId: "j1" })]);
  });

  it("concurrent sessions, not awaited: rows land whole and in call order even when the first write is slow", async () => {
    const ledger = new UsageLedger(dir);
    const ts = new Date(2026, 10, 15).getTime();
    const sessions = ["slow-first", ...Array.from({ length: 20 }, (_, i) => `telegram:${i}`)];
    // Fired without awaiting each one, as LiveSession does.
    for (const [i, key] of sessions.entries()) void ledger.append(row(ts, { sessionKey: key, trigger: String(i % 10).repeat(80) }));
    await ledger.idle();
    const lines = readFileSync(join(dir, ledgerFileName(ts)), "utf-8").split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as UsageLedgerRow);
    expect(parsed.map((r) => r.sessionKey)).toEqual(sessions);
    expect(parsed.every((r, i) => r.trigger === String(i % 10).repeat(80))).toBe(true);
  });

  it("keeps the ledger owner-only: files 0600, the directory 0700, even when either already existed wider", async () => {
    const usageDir = join(dir, "usage");
    const ts = new Date(2026, 10, 15).getTime();
    await new UsageLedger(usageDir).append(row(ts));
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(usageDir)).toBe(0o700);
    expect(mode(join(usageDir, ledgerFileName(ts)))).toBe(0o600);

    // A directory limits-log made first, and a month file from an older build.
    const wider = join(dir, "wider");
    mkdirSync(wider, { mode: 0o755 });
    chmodSync(wider, 0o755);
    writeFileSync(join(wider, ledgerFileName(ts)), "", { mode: 0o644 });
    chmodSync(join(wider, ledgerFileName(ts)), 0o644);
    await new UsageLedger(wider).append(row(ts));
    expect(mode(wider)).toBe(0o700);
    expect(mode(join(wider, ledgerFileName(ts)))).toBe(0o600);
  });

  it("swallows a write failure with one warn per streak, and recovers once the path is writable again", async () => {
    // A FILE where the directory should be: every write fails.
    const usageDir = join(dir, "usage");
    writeFileSync(usageDir, "not a directory");
    const ledger = new UsageLedger(usageDir);
    const ts = new Date(2026, 10, 15).getTime();

    await expect(ledger.append(row(ts))).resolves.toBeUndefined();
    await expect(ledger.append(row(ts))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ dir: usageDir }), expect.stringContaining("usage ledger"));

    rmSync(usageDir);
    await ledger.append(row(ts));
    const file = join(usageDir, ledgerFileName(ts));
    expect(readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(1);

    // A new failure streak warns again.
    chmodSync(file, 0o400);
    try {
      await ledger.append(row(ts));
      expect(log.warn).toHaveBeenCalledTimes(2);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("UsageLedger.lastSnapshot — the ledger is where a resume finds its baseline", () => {
  let dir: string;
  beforeEach(() => { vi.clearAllMocks(); dir = mkdtempSync(join(tmpdir(), "tomo-usage-snap-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const snap = (usd: number, sid = "sid-1") => ({ sdkSessionId: sid, totalCostUsd: usd, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreated: 0 } });
  const ts = new Date(2026, 10, 15).getTime();

  it("reads the last row's snapshot for that session and SDK session, from disk", async () => {
    const writer = new UsageLedger(dir);
    await writer.append(row(ts, { sdkSessionId: "sid-1", snapshot: snap(1) }));
    await writer.append(row(ts, { sessionKey: "telegram:9", sdkSessionId: "sid-9", snapshot: snap(9, "sid-9") }));
    await writer.append(row(ts, { sdkSessionId: "sid-1", snapshot: snap(2) }));
    // A fresh process: nothing cached, the file is the only source.
    const reader = new UsageLedger(dir);
    expect(reader.lastSnapshot("dm:owner", "sid-1")).toEqual(snap(2));
    expect(reader.lastSnapshot("telegram:9", "sid-9")).toEqual(snap(9, "sid-9"));
    expect(reader.lastSnapshot("dm:owner", "sid-other")).toBeUndefined();
    expect(writer.lastSnapshot("dm:owner", "sid-1")).toEqual(snap(2));
  });

  it("steps back over a torn or corrupt last line to the row before it", async () => {
    const writer = new UsageLedger(dir);
    await writer.append(row(ts, { sdkSessionId: "sid-1", snapshot: snap(1) }));
    const file = join(dir, ledgerFileName(ts));
    // A crash mid-append: half a row, naming the same session, then garbage.
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"sessionKey":"dm:owner","sdkSessionId":"sid-1","snapshot":{"sdkSess\nnot json sid-1\n`);
    expect(new UsageLedger(dir).lastSnapshot("dm:owner", "sid-1")).toEqual(snap(1));
  });

  it("a torn tail gets its own line before the next append: the new row reads back after a restart, the torn one never counts", async () => {
    const first = new UsageLedger(dir);
    await first.append(row(ts, { sdkSessionId: "sid-1", costUsd: 1, snapshot: snap(1) }));
    const file = join(dir, ledgerFileName(ts));
    // The daemon died mid-append: half a row, no newline.
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"ts":${ts},"sessionKey":"dm:owner","sdkSessionId":"sid-1","costUsd":0.5,"snap`);

    // A restarted daemon appends the next row.
    await new UsageLedger(dir).append(row(ts, { sdkSessionId: "sid-1", costUsd: 0.5, snapshot: snap(1.5) }));

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    const parsed = lines.flatMap((l) => { try { return [JSON.parse(l) as UsageLedgerRow]; } catch { return []; } });
    expect(parsed.map((r) => r.costUsd)).toEqual([1, 0.5]);
    expect(new UsageLedger(dir).lastSnapshot("dm:owner", "sid-1")).toEqual(snap(1.5));
  });

  it("a row whose counters cannot be trusted says so (null), rather than falling back further", async () => {
    const writer = new UsageLedger(dir);
    await writer.append(row(ts, { sdkSessionId: "sid-1", snapshot: snap(1) }));
    await writer.append(row(ts, { sdkSessionId: "sid-1" })); // a reset: no snapshot
    expect(new UsageLedger(dir).lastSnapshot("dm:owner", "sid-1")).toBeNull();
    expect(writer.lastSnapshot("dm:owner", "sid-1")).toBeNull();
  });

  it("a failed append leaves the baseline where it was, and never calls onWritten", async () => {
    const ledger = new UsageLedger(dir);
    const landed: number[] = [];
    await ledger.append(row(ts, { sdkSessionId: "sid-1", snapshot: snap(1) }), () => landed.push(1));
    const file = join(dir, ledgerFileName(ts));
    chmodSync(file, 0o400);
    try {
      await ledger.append(row(ts, { sdkSessionId: "sid-1", snapshot: snap(2) }), () => landed.push(2));
    } finally {
      chmodSync(file, 0o600);
    }
    expect(landed).toEqual([1]);
    expect(ledger.lastSnapshot("dm:owner", "sid-1")).toEqual(snap(1));
    expect(new UsageLedger(dir).lastSnapshot("dm:owner", "sid-1")).toEqual(snap(1));
  });

  it("builds a session's rows strictly one after another, even across month files", async () => {
    const ledger = new UsageLedger(dir);
    const order: string[] = [];
    const oct = new Date(2026, 9, 31, 23, 59).getTime();
    const nov = new Date(2026, 10, 1, 0, 1).getTime();
    let committed = 0;
    // "slow-first" makes the October write slow (see the fs mock above).
    void ledger.appendFor("slow-first", () => { order.push(`build1@${committed}`); return row(oct, { sessionKey: "slow-first" }); }, () => { committed = 1; });
    void ledger.appendFor("slow-first", () => { order.push(`build2@${committed}`); return row(nov, { sessionKey: "slow-first" }); }, () => { committed = 2; });
    await ledger.idle();
    expect(order).toEqual(["build1@0", "build2@1"]);
    expect(committed).toBe(2);
  });
});

describe("usage attribution", () => {
  it("names the month file YYYY-MM", () => {
    expect(ledgerFileName(new Date(2026, 0, 5).getTime())).toBe("2026-01.ndjson");
  });

  it("maps every source onto the Cost page's three buckets", () => {
    expect(usageCategory("owner")).toBe("you");
    expect(usageCategory("group")).toBe("you");
    expect(usageCategory("cron")).toBe("scheduled");
    expect(usageCategory("system")).toBe("scheduled");
    expect(usageCategory("delegate")).toBe("scheduled");
    expect(usageCategory("heartbeat")).toBe("background");
    expect(usageCategory("restart")).toBe("background");
    expect(usageCategory("background")).toBe("background");
  });

  it("clips the trigger to its first characters and unwraps a harness envelope", () => {
    expect(triggerSnippet("  hello\n\n  there ")).toBe("hello there");
    expect(triggerSnippet("")).toBeUndefined();
    const long = "字".repeat(200);
    expect(triggerSnippet(long)).toBe("字".repeat(TRIGGER_MAX_CHARS));
    const cron = formatTomoEvent("cron", 'Scheduled task "Digest" triggered. Summarise the inbox', { name: "Digest" });
    expect(triggerSnippet(cron)).toBe('Scheduled task "Digest" triggered. Summarise the inbox');
  });

  it("scrubs credentials out of the trigger before clipping it", () => {
    for (const [prompt, secret] of [
      ["use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx to call it", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"],
      ["curl -H 'Authorization: Bearer abcDEF1234567890xyz' https://x", "abcDEF1234567890xyz"],
      ["the wifi password=Sup3rSecretPass please", "Sup3rSecretPass"],
      ["token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ] as const) {
      const snippet = triggerSnippet(prompt)!;
      expect(snippet).not.toContain(secret);
      expect(snippet).toContain("***");
    }
    // A key that straddles the 80-character cut is still caught whole.
    const straddling = `${"x ".repeat(36)}sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx`;
    expect(triggerSnippet(straddling)).not.toContain("sk-ant-api03-AbCd");
    expect(triggerSnippet("an ordinary message")).toBe("an ordinary message");
  });

  it("derives the source from the ingress path when the spec names none", () => {
    expect(usageAttributionFor({ source: "user", key: "dm:owner", prompt: "hi" })).toEqual({ source: "owner", trigger: "hi" });
    expect(usageAttributionFor({ source: "user", key: "telegram:-100123", prompt: "hi" }).source).toBe("group");
    expect(usageAttributionFor({ source: "cron", key: "dm:owner", prompt: "nudge" }).source).toBe("system");
    expect(usageAttributionFor({ source: "continuity", key: "dm:owner", prompt: "beat" }).source).toBe("heartbeat");
    expect(usageAttributionFor({
      source: "cron", key: "dm:owner", prompt: "x", usage: { source: "cron", jobId: "j1", jobName: "Digest" },
    })).toEqual({ source: "cron", jobId: "j1", jobName: "Digest", trigger: "x" });
  });
});

describe("ledger start marker", () => {
  it("is written once: a later start keeps the first time; owner-only", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tomo-ledger-start-")), "usage");
    new UsageLedger(dir).markStarted(1_000);
    new UsageLedger(dir).markStarted(9_000);
    expect(readLedgerStarted(dir)).toBe(1_000);
    expect(statSync(join(dir, LEDGER_STARTED_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([LEDGER_STARTED_FILE]);
  });

  it("never replaces a marker that is there, even one it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-ledger-start-"));
    writeFileSync(join(dir, LEDGER_STARTED_FILE), "garbage");
    writeLedgerStarted(dir, 9_000);
    expect(readFileSync(join(dir, LEDGER_STARTED_FILE), "utf8")).toBe("garbage");
    expect(readdirSync(dir)).toEqual([LEDGER_STARTED_FILE]);
  });

  it("a ledger that ran before the marker existed is dated by its earliest row", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-ledger-start-"));
    writeFileSync(join(dir, "2026-11.ndjson"), [JSON.stringify({ ts: 5_000 }), JSON.stringify({ ts: 3_000 }), "{\"ts\":1"].join("\n"));
    writeFileSync(join(dir, "2026-12.ndjson"), JSON.stringify({ ts: 2_000 }) + "\n");
    expect(writeLedgerStarted(dir, 9_000)).toBe(3_000);
    expect(readLedgerStarted(dir)).toBe(3_000);
  });
});
