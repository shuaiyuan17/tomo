import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTomoDb } from "../src/db/index.js";
import { deleteMeta, digestOf, isPlaceholder, keepAside, metaValue, setMeta, writePlaceholder } from "../src/db/legacy.js";

// The helpers the JSON-file-to-database imports share (src/db/legacy.ts).

const ROOT = mkdtempSync(join(tmpdir(), "tomo-db-legacy-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const dir = join(ROOT, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("meta rows", () => {
  it("set, overwrite, read and delete", () => {
    const db = openTomoDb(join(fresh(), "tomo.db"));
    try {
      expect(metaValue(db, "k")).toBeUndefined();
      setMeta(db, "k", "1");
      setMeta(db, "k", "2");
      expect(metaValue(db, "k")).toBe("2");
      expect(deleteMeta(db, "k")).toBe(1);
      expect(deleteMeta(db, "k")).toBe(0);
      expect(metaValue(db, "k")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("keepAside", () => {
  it("copies the content beside the file once, and finds that copy again instead of making another", () => {
    const dir = fresh();
    const path = join(dir, "store.json");
    writeFileSync(path, "original");
    const first = keepAside(path, "original");
    expect(readFileSync(first, "utf8")).toBe("original");
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(keepAside(path, "original")).toBe(first);
    const other = keepAside(path, "different");
    expect(other).not.toBe(first);
    expect(readdirSync(dir).filter((f) => f.startsWith("store.json.migrated-"))).toHaveLength(2);
  });
});

describe("placeholders", () => {
  it("are recognised only without the store's own keys", () => {
    const dir = fresh();
    const path = join(dir, "nested", "store.json");
    writePlaceholder(path, { movedToDatabase: "/x/tomo.db", note: "moved" });
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(isPlaceholder(data, ["jobs"])).toBe(true);
    expect(isPlaceholder({ movedToDatabase: "/x", jobs: [] }, ["jobs"])).toBe(false);
    expect(isPlaceholder({ jobs: [] }, ["jobs"])).toBe(false);
    expect(isPlaceholder(null, ["jobs"])).toBe(false);
    expect(isPlaceholder(["movedToDatabase"], ["jobs"])).toBe(false);
  });

  it("digests are stable hex sha256", () => {
    expect(digestOf("abc")).toBe(digestOf(Buffer.from("abc")));
    expect(digestOf("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
