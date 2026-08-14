import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  consumeRestartReasonFile,
  resolveRestartInitiator,
  restartReasonSessionFile,
  writeRestartReasonFile,
} from "../src/restart-reason.js";
import {
  TOMO_DEFERRED_RESTART_PARENT_PID_ENV,
  recordRestartReason,
  scheduleDeferredRestart,
  shouldDeferRestart,
} from "../src/cli/daemon.js";

let tmpDir: string;
let reasonFile: string;
let sidecarFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `tomo-restart-reason-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmpDir, { recursive: true });
  reasonFile = join(tmpDir, "data", ".restart-reason");
  sidecarFile = restartReasonSessionFile(reasonFile);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("write/consume round trips", () => {
  it("round-trips an attributed entry and deletes both files on consume", () => {
    writeRestartReasonFile(reasonFile, { reason: "reload after login", sessionKey: "telegram:-100999" });
    expect(consumeRestartReasonFile(reasonFile)).toEqual({
      reason: "reload after login",
      sessionKey: "telegram:-100999",
    });
    expect(existsSync(reasonFile)).toBe(false);
    expect(existsSync(sidecarFile)).toBe(false);
  });

  it("always writes the reason file as bare plain text an old binary can read (rollback safety)", () => {
    writeRestartReasonFile(reasonFile, { reason: "resume the xhs notes", sessionKey: "telegram:-100123" });
    // An old binary does readFileSync(...).trim() on this file — it must see
    // clean reason text, never JSON or a session key.
    expect(readFileSync(reasonFile, "utf-8")).toBe("resume the xhs notes");
  });

  it("writes no sidecar for an unattributed entry", () => {
    writeRestartReasonFile(reasonFile, { reason: "auto-update" });
    expect(readFileSync(reasonFile, "utf-8")).toBe("auto-update");
    expect(existsSync(sidecarFile)).toBe(false);
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "auto-update" });
  });

  it("an unattributed write clears a stale sidecar from an earlier attributed write", () => {
    writeRestartReasonFile(reasonFile, { reason: "first", sessionKey: "dm:shuai" });
    writeRestartReasonFile(reasonFile, { reason: "second" });
    expect(existsSync(sidecarFile)).toBe(false);
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "second" });
  });

  it("consumes an old-binary plain-text reason (no sidecar) as unattributed", () => {
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(reasonFile, "Restarted before the upgrade\n", "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "Restarted before the upgrade" });
    expect(existsSync(reasonFile)).toBe(false);
  });

  it("returns null when the reason file is absent or blank, cleaning any orphaned sidecar", () => {
    expect(consumeRestartReasonFile(reasonFile)).toBeNull();

    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(sidecarFile, JSON.stringify({ sessionKey: "dm:shuai", reason: "gone" }), "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toBeNull();
    expect(existsSync(sidecarFile)).toBe(false);

    writeFileSync(reasonFile, "   ", "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toBeNull();
    expect(existsSync(reasonFile)).toBe(false);
  });
});

describe("sidecar degradation (never a crash, never a wrong session)", () => {
  function seedReason(reason: string): void {
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(reasonFile, reason, "utf-8");
  }

  it("degrades a garbage (non-JSON) sidecar to unattributed", () => {
    seedReason("real reason");
    writeFileSync(sidecarFile, "not json at all", "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "real reason" });
    expect(existsSync(sidecarFile)).toBe(false);
  });

  it("degrades a sidecar with a missing/empty/whitespace session key to unattributed", () => {
    seedReason("real reason");
    writeFileSync(sidecarFile, JSON.stringify({ reason: "real reason" }), "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "real reason" });

    seedReason("real reason");
    writeFileSync(sidecarFile, JSON.stringify({ sessionKey: "   ", reason: "real reason" }), "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "real reason" });

    seedReason("real reason");
    writeFileSync(sidecarFile, JSON.stringify({ sessionKey: "has spaces", reason: "real reason" }), "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "real reason" });
  });

  it("ignores a stale sidecar whose reason echo does not match (rollback then old-binary write)", () => {
    // New binary wrote an attributed reason; rollback: the old binary consumed
    // the reason file but left the sidecar; later the old binary wrote a NEW
    // plain-text reason. The stale sidecar must not attribute it.
    writeRestartReasonFile(reasonFile, { reason: "old attributed reason", sessionKey: "telegram:-100123" });
    writeFileSync(reasonFile, "fresh reason from the old binary", "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "fresh reason from the old binary" });
    expect(existsSync(sidecarFile)).toBe(false);
  });
});

describe("resolveRestartInitiator", () => {
  it("prefers an explicit --session over the env var", () => {
    expect(resolveRestartInitiator("dm:override", { TOMO_SESSION_KEY: "telegram:-1" })).toBe("dm:override");
  });

  it("falls back to TOMO_SESSION_KEY, then to unattributed", () => {
    expect(resolveRestartInitiator(undefined, { TOMO_SESSION_KEY: "telegram:-1" })).toBe("telegram:-1");
    expect(resolveRestartInitiator("  ", { TOMO_SESSION_KEY: "  " })).toBeUndefined();
    expect(resolveRestartInitiator(undefined, {})).toBeUndefined();
  });
});

describe("recordRestartReason (CLI writer seam)", () => {
  it("writes reason text plus sidecar from the session's env, end to end", () => {
    recordRestartReason("mirroir reload", undefined, { TOMO_SESSION_KEY: "telegram:-100123" }, reasonFile);
    expect(readFileSync(reasonFile, "utf-8")).toBe("mirroir reload");
    expect(JSON.parse(readFileSync(sidecarFile, "utf-8"))).toEqual({
      sessionKey: "telegram:-100123",
      reason: "mirroir reload",
    });
    expect(consumeRestartReasonFile(reasonFile)).toEqual({
      reason: "mirroir reload",
      sessionKey: "telegram:-100123",
    });
  });

  it("lets --session override the env var", () => {
    recordRestartReason("r", "dm:shuai", { TOMO_SESSION_KEY: "telegram:-100123" }, reasonFile);
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "r", sessionKey: "dm:shuai" });
  });

  it("writes a plain unattributed reason from a bare terminal env", () => {
    recordRestartReason("manual restart", undefined, {}, reasonFile);
    expect(readFileSync(reasonFile, "utf-8")).toBe("manual restart");
    expect(existsSync(sidecarFile)).toBe(false);
  });
});

describe("session-aware restart deferral", () => {
  it("defers a restart attributed by the session env or explicit flag", () => {
    expect(shouldDeferRestart(undefined, { TOMO_SESSION_KEY: "dm:shuai" })).toBe(true);
    expect(shouldDeferRestart("dm:shuai", {})).toBe(true);
  });

  it("keeps terminal restarts synchronous and prevents worker recursion", () => {
    expect(shouldDeferRestart(undefined, {})).toBe(false);
    expect(shouldDeferRestart(undefined, {
      TOMO_SESSION_KEY: "dm:shuai",
      [TOMO_DEFERRED_RESTART_PARENT_PID_ENV]: "1234",
    })).toBe(false);
  });

  it("spawns a detached worker marked with its parent PID", () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));

    scheduleDeferredRestart(
      "/opt/tomo/dist/cli.js",
      { TOMO_SESSION_KEY: "dm:shuai", KEEP_ME: "yes" },
      4321,
      spawnFn,
    );

    expect(spawnFn).toHaveBeenCalledWith(
      process.execPath,
      ["/opt/tomo/dist/cli.js", "restart"],
      {
        detached: true,
        stdio: "ignore",
        env: {
          TOMO_SESSION_KEY: "dm:shuai",
          KEEP_ME: "yes",
          [TOMO_DEFERRED_RESTART_PARENT_PID_ENV]: "4321",
        },
      },
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
