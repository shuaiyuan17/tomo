import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRIGGER_MAX_CHARS,
  UsageLedger,
  ledgerFileName,
  triggerSnippet,
  usageCategory,
  type UsageLedgerRow,
} from "../src/metrics/usage-ledger.js";
import { formatTomoEvent } from "../src/tomo-event.js";
import { usageAttributionFor } from "../src/agent/turn-runner.js";

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

  it("appends one JSON line per row to the file for the row's local month, creating the directory", () => {
    const usageDir = join(dir, "data", "usage");
    const ledger = new UsageLedger(usageDir);
    const oct = new Date(2026, 9, 31, 23, 59).getTime();
    const nov = new Date(2026, 10, 1, 0, 1).getTime();
    ledger.append(row(oct));
    ledger.append(row(nov));
    ledger.append(row(nov, { source: "cron", jobId: "j1" }));

    const read = (name: string) => readFileSync(join(usageDir, name), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(read("2026-10.ndjson")).toEqual([row(oct)]);
    expect(read("2026-11.ndjson")).toEqual([row(nov), row(nov, { source: "cron", jobId: "j1" })]);
  });

  it("keeps rows from concurrent sessions whole and in call order", async () => {
    const ledger = new UsageLedger(dir);
    const ts = new Date(2026, 10, 15).getTime();
    // Many sessions finishing at once, each with a long trigger so a torn
    // write would show; read back the moment the last append returns.
    const sessions = Array.from({ length: 40 }, (_, i) => `telegram:${i}`);
    await Promise.all(sessions.map(async (key, i) => {
      await Promise.resolve();
      ledger.append(row(ts, { sessionKey: key, trigger: String(i).repeat(80) }));
    }));
    const lines = readFileSync(join(dir, ledgerFileName(ts)), "utf-8").split("\n").filter(Boolean);
    expect(lines.map((l) => (JSON.parse(l) as UsageLedgerRow).sessionKey)).toEqual(sessions);
  });

  it("swallows a write failure with one warn, and recovers once the path is writable again", () => {
    // A FILE where the directory should be: every write fails.
    const usageDir = join(dir, "usage");
    writeFileSync(usageDir, "not a directory");
    const ledger = new UsageLedger(usageDir);
    const ts = new Date(2026, 10, 15).getTime();

    expect(() => ledger.append(row(ts))).not.toThrow();
    expect(() => ledger.append(row(ts))).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ dir: usageDir }), expect.stringContaining("usage ledger"));

    rmSync(usageDir);
    ledger.append(row(ts));
    expect(readFileSync(join(usageDir, ledgerFileName(ts)), "utf-8").trim().split("\n")).toHaveLength(1);

    // A new failure streak warns again.
    const file = join(usageDir, ledgerFileName(ts));
    chmodSync(file, 0o400);
    try {
      ledger.append(row(ts));
      expect(log.warn).toHaveBeenCalledTimes(2);
    } finally {
      chmodSync(file, 0o600);
    }
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
