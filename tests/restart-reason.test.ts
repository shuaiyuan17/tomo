import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  consumeRestartReasonFile,
  parseRestartReason,
  serializeRestartReason,
  writeRestartReasonFile,
} from "../src/restart-reason.js";

let tmpDir: string;
let reasonFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `tomo-restart-reason-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmpDir, { recursive: true });
  reasonFile = join(tmpDir, "data", ".restart-reason");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseRestartReason", () => {
  it("parses an attributed JSON payload", () => {
    expect(parseRestartReason('{"reason":"resume the xhs notes","sessionKey":"telegram:-100123"}')).toEqual({
      reason: "resume the xhs notes",
      sessionKey: "telegram:-100123",
    });
  });

  it("parses a legacy plain-text reason (old-binary file format)", () => {
    expect(parseRestartReason("Updated from v0.8.11 to v0.8.12\n")).toEqual({
      reason: "Updated from v0.8.11 to v0.8.12",
    });
  });

  it("treats a brace-leading non-JSON reason as plain text", () => {
    expect(parseRestartReason("{oops, not json")).toEqual({ reason: "{oops, not json" });
  });

  it("treats JSON without a string reason as plain text rather than erroring", () => {
    const raw = '{"sessionKey":"dm:shuai"}';
    expect(parseRestartReason(raw)).toEqual({ reason: raw });
  });

  it("ignores a blank sessionKey", () => {
    expect(parseRestartReason('{"reason":"r","sessionKey":"  "}')).toEqual({ reason: "r" });
  });

  it("returns null for blank content", () => {
    expect(parseRestartReason("")).toBeNull();
    expect(parseRestartReason("  \n ")).toBeNull();
    expect(parseRestartReason('{"reason":"   "}')).toBeNull();
  });
});

describe("serializeRestartReason", () => {
  it("keeps unattributed reasons byte-identical to the legacy plain-text format", () => {
    expect(serializeRestartReason({ reason: "manual terminal restart" })).toBe("manual terminal restart");
  });

  it("round-trips an attributed reason through JSON", () => {
    const entry = { reason: 'quotes "and" braces {}', sessionKey: "dm:shuai" };
    expect(parseRestartReason(serializeRestartReason(entry))).toEqual(entry);
  });
});

describe("write/consume file", () => {
  it("round-trips an attributed entry and deletes the file on consume", () => {
    writeRestartReasonFile(reasonFile, { reason: "reload after login", sessionKey: "telegram:-100999" });
    expect(consumeRestartReasonFile(reasonFile)).toEqual({
      reason: "reload after login",
      sessionKey: "telegram:-100999",
    });
    expect(existsSync(reasonFile)).toBe(false);
  });

  it("writes unattributed entries as plain text an old binary could read", () => {
    writeRestartReasonFile(reasonFile, { reason: "auto-update" });
    expect(readFileSync(reasonFile, "utf-8")).toBe("auto-update");
  });

  it("consumes an old-format plain-text file left by a previous binary", () => {
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(reasonFile, "Restarted before the upgrade\n", "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toEqual({ reason: "Restarted before the upgrade" });
    expect(existsSync(reasonFile)).toBe(false);
  });

  it("returns null when the file is absent or blank", () => {
    expect(consumeRestartReasonFile(reasonFile)).toBeNull();
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(reasonFile, "   ", "utf-8");
    expect(consumeRestartReasonFile(reasonFile)).toBeNull();
    expect(existsSync(reasonFile)).toBe(false);
  });
});
