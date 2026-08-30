import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { SessionMessage } from "../src/sessions/types.js";

/**
 * Concurrency around transcript rotation (issue #312, finding 5).
 *
 * Rotation is reachable from `SessionStore.get()`, and `get()` runs in a
 * SECOND process: `tomo config identities` builds its own store while the
 * daemon is up. So the interesting cases are all "someone else touched the
 * file between our read and our rename", which this file reproduces by
 * hooking `writeFileSync` — the moment the rewritten transcript hits its temp
 * path is exactly the middle of that window.
 *
 * HERMETIC BY CONSTRUCTION, under any version of the code. `HOME` is pointed
 * at a temp directory in a hoisted block, i.e. before a single module of the
 * system under test is imported and therefore before anything can resolve a
 * path from it; `node:os`'s `homedir()` is redirected to the same place; and
 * every store is constructed with an explicit directory under it. Nothing
 * here can reach the real `~/.tomo` even if the code under test ignores the
 * arguments it is given.
 */
const env = vi.hoisted(() => {
  const home = `/tmp/tomo-rotation-test-${process.pid}`;
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  return {
    home,
    originalHome,
    dir: `${home}/sessions`,
    hooks: {
      onRotateTempWritten: null as null | (() => void),
      onStat: null as null | ((path: string) => void),
    },
  };
});

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => env.home }, homedir: () => env.home };
});

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    // Fires once the rewritten transcript has been written to its temp path
    // but before it is renamed into place — the window a concurrent appender
    // or a second rotator lives in.
    writeFileSync: ((path: unknown, data: unknown, opts?: unknown) => {
      const result = (actual.writeFileSync as (...a: unknown[]) => unknown)(path, data, opts);
      if (typeof path === "string" && path.includes(".rotate-tmp")) env.hooks.onRotateTempWritten?.();
      return result;
    }) as typeof actual.writeFileSync,
    statSync: ((path: unknown, opts?: unknown) => {
      const result = (actual.statSync as (...a: unknown[]) => unknown)(path, opts);
      if (typeof path === "string") env.hooks.onStat?.(path);
      return result;
    }) as typeof actual.statSync,
  };
});

const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync }
  = await import("node:fs");
const { join } = await import("node:path");
const { SessionStore } = await import("../src/sessions/store.js");

const TRANSCRIPT = join(env.dir, "test.jsonl");
const ARCHIVE_JAN = join(env.dir, "_archive_test_2020-01.jsonl");

function msg(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    role: "user",
    content: "hello",
    channel: "telegram",
    timestamp: Date.now(),
    ...overrides,
  } as SessionMessage;
}

/** A store whose rotation threshold is 1 byte, so `get()` always rotates. */
function store(): InstanceType<typeof SessionStore> {
  return new SessionStore(env.dir, 20, join(env.dir, "sdk-sessions"), { rotateBytes: 1 });
}

/** Two prior-month messages (rotatable) plus one current-month message. */
const JAN = Date.UTC(2020, 0, 15);

function seedTranscript(): void {
  mkdirSync(env.dir, { recursive: true });
  writeFileSync(TRANSCRIPT, [
    msg({ content: "jan one", seq: 1, timestamp: JAN }),
    msg({ content: "jan two", seq: 2, timestamp: JAN + 1000 }),
    msg({ content: "now one", seq: 3 }),
  ].map((m) => JSON.stringify(m)).join("\n") + "\n");
}

function activeLines(): string[] {
  return readFileSync(TRANSCRIPT, "utf-8").trim().split("\n").filter(Boolean);
}

function contentsOf(lines: string[]): string[] {
  return lines.map((l) => (JSON.parse(l) as SessionMessage).content);
}

beforeEach(() => {
  rmSync(env.home, { recursive: true, force: true });
  seedTranscript();
  env.hooks.onRotateTempWritten = null;
  env.hooks.onStat = null;
});

afterEach(() => {
  env.hooks.onRotateTempWritten = null;
  env.hooks.onStat = null;
});

afterAll(() => {
  rmSync(env.home, { recursive: true, force: true });
  if (env.originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.originalHome;
});

describe("transcript rotation under concurrency", () => {
  it("keeps a message appended while the rotation is in flight", () => {
    // The daemon appending an inbound message while the CLI rotates. The old
    // code read the file once and renamed its rewrite over the top, so this
    // message was erased — permanently, with no log line, and `getLastSeq`
    // then handed its seq to the next message as well.
    env.hooks.onRotateTempWritten = () => {
      appendFileSync(TRANSCRIPT, JSON.stringify(msg({ content: "arrived mid-rotation", seq: 4 })) + "\n");
    };

    const session = store().get("test");

    expect(contentsOf(activeLines())).toEqual(["now one", "arrived mid-rotation"]);
    expect(session.messages.map((m) => m.content)).toContain("now one");
    // And nothing was lost from the archived end either.
    const all = store().searchTranscript("test", { limit: 100 });
    expect(all.map((m) => m.content)).toEqual(["jan one", "jan two", "now one", "arrived mid-rotation"]);
  });

  it("does not let two rotators interleave", () => {
    // A second rotator enters exactly when the first has written its temp file
    // and has not yet renamed it. With a fixed temp name both processes use
    // the same path: the second renames it away and the first's rename then
    // fails with ENOENT, out of `get()`, in whichever process lost the race.
    let reentered = false;
    env.hooks.onRotateTempWritten = () => {
      if (reentered) return;
      reentered = true;
      store().get("test");
    };

    expect(() => store().get("test")).not.toThrow();
    expect(reentered).toBe(true);

    // No message lost and none duplicated, in the active file or the archive.
    expect(contentsOf(activeLines())).toEqual(["now one"]);
    expect(readFileSync(ARCHIVE_JAN, "utf-8").trim().split("\n")).toHaveLength(2);
    const all = store().searchTranscript("test", { limit: 100 });
    expect(all.map((m) => m.content)).toEqual(["jan one", "jan two", "now one"]);
  });

  it("tolerates the transcript disappearing between the size check and the read", () => {
    // `tomo sessions clear`, or another rotator that took over a stale lock.
    // Rotation is an optimization; it must give up quietly rather than throw
    // ENOENT out of `get()` and take the caller's turn with it.
    let armed = true;
    env.hooks.onStat = (path) => {
      if (!armed || path !== TRANSCRIPT) return;
      armed = false;
      rmSync(TRANSCRIPT, { force: true });
    };

    let session!: ReturnType<InstanceType<typeof SessionStore>["get"]>;
    expect(() => { session = store().get("test"); }).not.toThrow();
    expect(session.messages).toEqual([]);
  });

  it("leaves no temp or lock files behind after a successful rotation", () => {
    store().get("test");
    const leftovers = readdirSync(env.dir).filter((n) => n.includes(".rotate-"));
    expect(leftovers).toEqual([]);
  });

  it("skips rotation while another process holds a fresh lock", () => {
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "999999 held by someone else\n");

    const before = readFileSync(TRANSCRIPT, "utf-8");
    store().get("test");

    // Untouched: the prior-month messages are still in the active file and
    // nothing was archived behind the other rotator's back.
    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(existsSync(ARCHIVE_JAN)).toBe(false);
    // The lock is someone else's; we must not have removed it.
    expect(existsSync(lockPath)).toBe(true);
  });

  it("takes over a lock left behind by a crashed rotator", () => {
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "999999 crashed\n");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    store().get("test");

    expect(contentsOf(activeLines())).toEqual(["now one"]);
    expect(statSync(ARCHIVE_JAN).size).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(false);
  });
});
