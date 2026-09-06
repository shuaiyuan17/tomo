import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Person records are written on the MESSAGE path — `upsert_person` from a
 * turn, and the auto-binding that fires the first time a group sender's
 * display name matches an unbound record — so every write races a reader:
 * `loadDir` on the next inbound message, another upsert, a restart.
 *
 * A plain `writeFileSync` truncates first and fills after. A reader landing in
 * that window sees a file with no frontmatter and the person silently stops
 * being recognised; a crash in the same window makes that permanent.
 */
const state = vi.hoisted(() => ({ failRename: false }));

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: ((from: unknown, to: unknown) => {
      if (state.failRename) {
        const err = new Error(`EIO: i/o error, rename '${String(from)}'`) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return (actual.renameSync as (...a: unknown[]) => unknown)(from, to);
    }) as typeof actual.renameSync,
  };
});

const { savePersonRecord, loadPeople, parsePersonFile } = await import("../src/people.js");
const { log } = await import("../src/logger.js");

const root = mkdtempSync(join(tmpdir(), "tomo-people-atomic-"));
const publicDir = join(root, "people");
const privateDir = join(root, "private", "people");

beforeEach(() => {
  state.failRename = false;
  rmSync(publicDir, { recursive: true, force: true });
  mkdirSync(publicDir, { recursive: true });
});

afterEach(() => {
  state.failRename = false;
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ORIGINAL = "---\nname: Alice\naliases: ali\n---\n\nLikes tea.\n";

function seed(): string {
  const filePath = join(publicDir, "alice.md");
  writeFileSync(filePath, ORIGINAL, "utf-8");
  return filePath;
}

describe("savePersonRecord", () => {
  it("publishes the new content by rename, leaving no debris", () => {
    const filePath = seed();
    const record = parsePersonFile(ORIGINAL, filePath, false)!;
    record.notes = "Likes coffee now.";

    savePersonRecord(record);

    expect(readFileSync(filePath, "utf-8")).toContain("Likes coffee now.");
    expect(readdirSync(publicDir)).toEqual(["alice.md"]);
  });

  it("leaves the previous record intact when the write cannot be published", () => {
    // Stands in for the crash: the point at which a non-atomic write has
    // already truncated the live file. Atomically, the failure happens on a
    // temp sibling and the record on disk never changes.
    const filePath = seed();
    const record = parsePersonFile(ORIGINAL, filePath, false)!;
    record.notes = "half a record";
    state.failRename = true;

    expect(() => savePersonRecord(record)).toThrow(/EIO/);

    expect(readFileSync(filePath, "utf-8")).toBe(ORIGINAL);
    expect(readdirSync(publicDir)).toEqual(["alice.md"]);
  });
});

describe("loadPeople", () => {
  it("names a record it could not parse instead of dropping it in silence", () => {
    seed();
    // Exactly what a truncated write leaves: an opening fence and half a
    // frontmatter. `parsePersonFile` returns undefined, the person stops
    // being recognised, and nothing said why.
    writeFileSync(join(publicDir, "torn.md"), "---\nname: Ke", "utf-8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const people = loadPeople({ includePrivate: false, dirs: { publicDir, privateDir } });

    expect(people.map((p) => p.name)).toEqual(["Alice"]);
    const warned = warn.mock.calls.filter((c) => String(c[1]).includes("no usable frontmatter"));
    expect(warned).toHaveLength(1);
    expect(warned[0][0]).toMatchObject({ filePath: join(publicDir, "torn.md") });
  });
});
