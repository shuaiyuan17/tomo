import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionMessage } from "../src/sessions/types.js";

/**
 * The migration's move must not overwrite a destination that appeared while it
 * was deciding.
 *
 * `existsSync(to)` then `renameSync(from, to)` is a check-then-act, and the
 * window between them is reachable in the field: `append()` in another process
 * (`tomo config identities` → `pickChatId` → `store.get()`, or `tomo lcm search
 * --channel-key`) creates `to`, and the rename then replaces that brand-new live
 * transcript with the legacy file — silently, with no sidecar and no log line.
 *
 * The window cannot be hit by timing from a test, so it is injected: `existsSync`
 * is made to lie about the destination exactly the way the race does. With
 * `link`+`unlink` the lie does not matter, because the destination's existence is
 * decided by the kernel inside the move rather than by a stat taken before it.
 */
const fsHook = vi.hoisted(() => ({ lieAbout: null as string | null, lies: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]): boolean => {
      if (fsHook.lieAbout !== null && String(path) === fsHook.lieAbout) {
        fsHook.lies++;
        return false;
      }
      return actual.existsSync(path);
    },
  };
});

vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
const { SessionStore, transcriptFileStem, legacyTranscriptFileStem } = await import("../src/sessions/store.js");

const TEST_ROOT = join(tmpdir(), `tomo-test-move-race-${process.pid}`);
const KEY = "imessage:any;-;alex.smith@example.com";
let testDir: string;
let counter = 0;

function record(content: string, timestamp: number, seq: number): string {
  const msg: SessionMessage = { role: "user", content, channel: "imessage", timestamp, seq };
  return JSON.stringify(msg) + "\n";
}

beforeEach(() => {
  testDir = join(TEST_ROOT, `case-${counter++}`);
  mkdirSync(testDir, { recursive: true });
  fsHook.lieAbout = null;
  fsHook.lies = 0;
});

afterEach(() => {
  fsHook.lieAbout = null;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("a transcript move never clobbers the destination", () => {
  it("sidecars instead of overwriting a destination that appeared mid-move", () => {
    const legacy = legacyTranscriptFileStem(KEY);
    const stem = transcriptFileStem(KEY);
    const legacyPath = join(testDir, `${legacy}.jsonl`);
    const newPath = join(testDir, `${stem}.jsonl`);
    writeFileSync(legacyPath, record("legacy history", Date.parse("2026-02-01T00:00:00Z"), 1));
    // What the other process wrote inside the window.
    writeFileSync(newPath, record("live append from another process", Date.parse("2026-02-02T00:00:00Z"), 1));
    fsHook.lieAbout = newPath;
    // The injection is wired and the path matches — without this the test could
    // pass for the wrong reason, by simply never reaching the window.
    expect(existsSync(newPath)).toBe(false);
    expect(fsHook.lies).toBe(1);
    fsHook.lies = 0;

    const store = new SessionStore(testDir, 20, join(testDir, "sdk-sessions"));
    store.setSdkSessionId(KEY, "sdk-1");
    const session = store.get(KEY);

    // The live transcript is intact — the move asked the kernel, not the stat.
    expect(readFileSync(newPath, "utf-8")).toContain("live append from another process");
    // …the legacy bytes became a read-only sidecar rather than overwriting it…
    const sidecars = readdirSync(testDir).filter((n) => /\.legacy-\d{8}-\d{6}(?:-\d+)?\.jsonl$/.test(n));
    expect(sidecars).toHaveLength(1);
    expect(readFileSync(join(testDir, sidecars[0]), "utf-8")).toContain("legacy history");
    // …and both are readable from the key.
    expect(session.messages.map((m) => m.content))
      .toEqual(["legacy history", "live append from another process"]);
    expect(store.searchTranscript(KEY, {}).map((m) => m.content))
      .toEqual(["legacy history", "live append from another process"]);
  });
});
