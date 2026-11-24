import { describe, expect, it, vi } from "vitest";

// Lets a test make `writeSync` write fewer bytes than asked (a full disk, a
// signal), and optionally fail after a number of calls.
const shortWrite = vi.hoisted(() => ({ max: 0, failAfter: -1, calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const writeSync = ((fd: number, buf: unknown, ...rest: unknown[]) => {
    if (shortWrite.max > 0 && Buffer.isBuffer(buf)) {
      shortWrite.calls++;
      if (shortWrite.failAfter >= 0 && shortWrite.calls > shortWrite.failAfter) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      const off = typeof rest[0] === "number" ? rest[0] : 0;
      const len = typeof rest[1] === "number" ? rest[1] : buf.length - off;
      return orig.writeSync(fd, buf, off, Math.min(len, shortWrite.max));
    }
    if (shortWrite.max > 0 && typeof buf === "string") {
      // A string write is a single write(2): emulate the short return.
      shortWrite.calls++;
      return orig.writeSync(fd, Buffer.from(buf).subarray(0, shortWrite.max));
    }
    return (orig.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest);
  }) as typeof orig.writeSync;
  return { ...orig, writeSync, default: { ...orig, writeSync } };
});

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backupFileIfExistsSync, writeFileAtomicSync, writeJsonAtomicSync } from "../src/fs-utils.js";

describe("fs utils", () => {
  it("preserves an existing file mode across atomic writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-fs-utils-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "old\n");
      chmodSync(path, 0o600);

      writeFileAtomicSync(path, "new\n");

      expect(readFileSync(path, "utf-8")).toBe("new\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fsync mode writes the same content and keeps the file mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-fs-utils-"));
    try {
      const path = join(dir, "notes.json");
      writeFileSync(path, "old\n");
      chmodSync(path, 0o600);
      writeJsonAtomicSync(path, { notes: ["a"] }, { fsync: true });
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ notes: ["a"] });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes json atomically with trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-fs-utils-"));
    try {
      const path = join(dir, "data.json");
      writeJsonAtomicSync(path, { ok: true });

      expect(readFileSync(path, "utf-8")).toBe("{\n  \"ok\": true\n}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies an explicit mode to json and backup files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-fs-utils-"));
    try {
      const path = join(dir, "config.json");
      const backupPath = join(dir, "config.json.bak");
      writeJsonAtomicSync(path, { secret: true }, { mode: 0o600 });
      backupFileIfExistsSync(path, backupPath, { mode: 0o600 });

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fsync mode keeps writing until every byte is out when writeSync writes short", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-fs-utils-"));
    Object.assign(shortWrite, { max: 7, failAfter: -1, calls: 0 });
    try {
      const path = join(dir, "registry.json");
      const value = { sessions: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, note: "é✓" })) };
      writeJsonAtomicSync(path, value, { fsync: true });
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(value);
      expect(shortWrite.calls).toBeGreaterThan(1);
    } finally {
      Object.assign(shortWrite, { max: 0, failAfter: -1, calls: 0 });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fsync mode leaves the old file in place when a write fails partway", () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-fs-utils-"));
    Object.assign(shortWrite, { max: 7, failAfter: 2, calls: 0 });
    try {
      const path = join(dir, "registry.json");
      writeFileSync(path, "old\n");
      expect(() => writeJsonAtomicSync(path, { sessions: ["a", "b", "c", "d"] }, { fsync: true })).toThrow(/ENOSPC/);
      expect(readFileSync(path, "utf-8")).toBe("old\n");
      expect(readdirSync(dir)).toEqual(["registry.json"]);
      expect(existsSync(`${path}.tmp`)).toBe(false);
    } finally {
      Object.assign(shortWrite, { max: 0, failAfter: -1, calls: 0 });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
