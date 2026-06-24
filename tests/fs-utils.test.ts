import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
});
