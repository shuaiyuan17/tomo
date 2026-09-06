import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A broken person file is worth one log line, not one per message.
 *
 * `loadPeople` runs on the inbound path — several times per message before the
 * request-scoped snapshot, once per message after it — and every one of those
 * loads re-read the same malformed record and re-warned about it. A single
 * hand-edited or half-written file therefore produced a warning per message,
 * indefinitely, and buried the log it was written to be visible in.
 */
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

const { log } = await import("../src/logger.js");
const { loadPeople } = await import("../src/people.js");

const TEST_DIR = join(tmpdir(), "tomo-test-people-warn-once");
const warn = log.warn as unknown as ReturnType<typeof vi.fn>;

const GOOD = `---
name: Kevin Wang
---

Notes.
`;

/** Fresh directories per test — the memo is keyed by path and lives for the
 *  process, so two tests sharing a filename would be testing each other. */
function dirsFor(id: string): { publicDir: string; privateDir: string } {
  const publicDir = join(TEST_DIR, id, "people");
  const privateDir = join(TEST_DIR, id, "private", "people");
  mkdirSync(publicDir, { recursive: true });
  return { publicDir, privateDir };
}

function warningsMatching(needle: string): unknown[] {
  return warn.mock.calls.filter((call) => String(call[1] ?? "").includes(needle));
}

beforeEach(() => {
  warn.mockClear();
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadPeople — malformed person file warnings", () => {
  it("warns once per process, not once per load", () => {
    const dirs = dirsFor("repeat");
    writeFileSync(join(dirs.publicDir, "torn.md"), "no frontmatter here\n", "utf-8");

    for (let i = 0; i < 5; i++) loadPeople({ includePrivate: false, dirs });

    expect(warningsMatching("no usable frontmatter")).toHaveLength(1);
  });

  it("still loads the records around the broken one on every load", () => {
    const dirs = dirsFor("around");
    writeFileSync(join(dirs.publicDir, "torn.md"), "no frontmatter here\n", "utf-8");
    writeFileSync(join(dirs.publicDir, "kevin.md"), GOOD, "utf-8");

    expect(loadPeople({ includePrivate: false, dirs })).toHaveLength(1);
    expect(loadPeople({ includePrivate: false, dirs })).toHaveLength(1);
    expect(warningsMatching("no usable frontmatter")).toHaveLength(1);
  });

  it("warns again after the file is repaired and broken a second time", () => {
    const dirs = dirsFor("repaired");
    const path = join(dirs.publicDir, "kevin.md");

    writeFileSync(path, "torn\n", "utf-8");
    loadPeople({ includePrivate: false, dirs });
    loadPeople({ includePrivate: false, dirs });
    expect(warningsMatching("no usable frontmatter")).toHaveLength(1);

    // Repaired: the memo for this path is cleared by a load that parses it.
    writeFileSync(path, GOOD, "utf-8");
    expect(loadPeople({ includePrivate: false, dirs })).toHaveLength(1);

    // Broken again — a new fact, said again rather than swallowed for the life
    // of the daemon.
    writeFileSync(path, "torn again\n", "utf-8");
    loadPeople({ includePrivate: false, dirs });
    loadPeople({ includePrivate: false, dirs });
    expect(warningsMatching("no usable frontmatter")).toHaveLength(2);
  });

  it("warns once per file, so two broken records are both named", () => {
    const dirs = dirsFor("two");
    writeFileSync(join(dirs.publicDir, "a.md"), "torn\n", "utf-8");
    writeFileSync(join(dirs.publicDir, "b.md"), "torn\n", "utf-8");

    loadPeople({ includePrivate: false, dirs });
    loadPeople({ includePrivate: false, dirs });

    const paths = warningsMatching("no usable frontmatter")
      .map((call) => (call as [{ filePath: string }, string])[0].filePath);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.endsWith("a.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("b.md"))).toBe(true);
  });
});
