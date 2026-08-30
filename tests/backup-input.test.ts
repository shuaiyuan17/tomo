import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_RETENTION_DAYS, isBackupName, resolveRetentionDays } from "../src/cli/backup.js";

afterEach(() => vi.restoreAllMocks());

describe("resolveRetentionDays", () => {
  it("uses the default when unset or empty", () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays("")).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("accepts a plain day count", () => {
    expect(resolveRetentionDays("14")).toBe(14);
    expect(resolveRetentionDays("1")).toBe(1);
  });

  it("falls back rather than letting a typo disable pruning entirely", () => {
    // Number("7d") is NaN; the cutoff becomes NaN and every `date < NaN`
    // comparison is false, so nothing is ever pruned and nothing says so.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveRetentionDays("7d")).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays("a week")).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("falls back rather than deleting the backup it just made", () => {
    // 0 puts the cutoff at now; the just-created backup's own timestamp is
    // minute-granular and therefore strictly older, so it is pruned too.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveRetentionDays("0")).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays("-1")).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("warns when it rejects a value, so the override is not silently ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveRetentionDays("7d");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("TOMO_BACKUP_RETENTION_DAYS");
  });
});

describe("isBackupName", () => {
  it("accepts the timestamp() shape", () => {
    expect(isBackupName("2026-08-30_0142")).toBe(true);
  });

  it("rejects traversal", () => {
    expect(isBackupName("..")).toBe(false);
    expect(isBackupName("../../..")).toBe(false);
    expect(isBackupName("../2026-08-30_0142")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(isBackupName("/Users/someone/Documents")).toBe(false);
  });

  it("rejects a near-miss shape", () => {
    expect(isBackupName("2026-08-30")).toBe(false);
    expect(isBackupName("2026-08-30_014")).toBe(false);
    expect(isBackupName("2026-08-30_0142x")).toBe(false);
  });
});
