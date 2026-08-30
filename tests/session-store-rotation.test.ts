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
      onRenamed: null as null | ((from: string, to: string) => void),
      /** Make openSync of the lock file fail with this errno. */
      failLockOpen: null as string | null,
      /** Make renameSync of the rewritten temp file fail. */
      failTempRename: false,
      /** Make appendFileSync onto the rewritten temp file fail. */
      failTempAppend: false,
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
    openSync: ((path: unknown, flags?: unknown, mode?: unknown) => {
      if (env.hooks.failLockOpen && typeof path === "string" && path.endsWith(".rotate-lock")) {
        const err = new Error(`${env.hooks.failLockOpen}: permission denied, open '${path}'`);
        (err as NodeJS.ErrnoException).code = env.hooks.failLockOpen;
        throw err;
      }
      return (actual.openSync as (...a: unknown[]) => number)(path, flags, mode);
    }) as typeof actual.openSync,
    renameSync: ((from: unknown, to: unknown) => {
      if (env.hooks.failTempRename && typeof from === "string" && from.includes(".rotate-tmp")) {
        const err = new Error(`EIO: i/o error, rename '${String(from)}'`);
        (err as NodeJS.ErrnoException).code = "EIO";
        throw err;
      }
      (actual.renameSync as (...a: unknown[]) => void)(from, to);
      if (typeof from === "string" && typeof to === "string") env.hooks.onRenamed?.(from, to);
    }) as typeof actual.renameSync,
    appendFileSync: ((path: unknown, data: unknown, opts?: unknown) => {
      if (env.hooks.failTempAppend && typeof path === "string" && path.includes(".rotate-tmp")) {
        const err = new Error(`ENOSPC: no space left on device, write '${String(path)}'`);
        (err as NodeJS.ErrnoException).code = "ENOSPC";
        throw err;
      }
      return (actual.appendFileSync as (...a: unknown[]) => unknown)(path, data, opts);
    }) as typeof actual.appendFileSync,
  };
});

// Captures the warn/error lines the rotation path emits, so "skipped
// silently" and "skipped and said why" are distinguishable.
const logLines = vi.hoisted(() => ({ warn: [] as string[], error: [] as string[], info: [] as string[] }));
vi.mock("../src/logger.js", () => ({
  log: {
    info: vi.fn((_o: unknown, m?: string) => { logLines.info.push(m ?? String(_o)); }),
    warn: vi.fn((_o: unknown, m?: string) => { logLines.warn.push(m ?? String(_o)); }),
    error: vi.fn((_o: unknown, m?: string) => { logLines.error.push(m ?? String(_o)); }),
    debug: vi.fn(),
  },
}));

const { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync }
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
  resetHooks();
});

afterEach(() => {
  resetHooks();
});

function resetHooks(): void {
  env.hooks.onRotateTempWritten = null;
  env.hooks.onStat = null;
  env.hooks.onRenamed = null;
  env.hooks.failLockOpen = null;
  env.hooks.failTempRename = false;
  env.hooks.failTempAppend = false;
  logLines.warn.length = 0;
  logLines.error.length = 0;
  logLines.info.length = 0;
}

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

  it("does not throw out of get() when the lock cannot be created", () => {
    // An unwritable sessions directory, a read-only mount, EMFILE. `get()` is
    // on the inbound message path: failing to ROTATE must never become failing
    // to receive a message.
    env.hooks.failLockOpen = "EACCES";

    const before = readFileSync(TRANSCRIPT, "utf-8");
    let session!: ReturnType<InstanceType<typeof SessionStore>["get"]>;
    expect(() => { session = store().get("test"); }).not.toThrow();

    // Skipped, not half-done — and it said so rather than failing silently.
    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(existsSync(ARCHIVE_JAN)).toBe(false);
    expect(session.messages.map((m) => m.content)).toEqual(["jan one", "jan two", "now one"]);
    expect(logLines.warn.join("\n")).toContain("Could not take the transcript rotation lock");
  });

  it("does not steal a lock refreshed between the staleness check and the takeover", () => {
    // The takeover TOCTOU. Our rotator stats an abandoned lock and decides it
    // is dead; before it can act, the rotator that owns the file releases it
    // and a THIRD one takes the lock legitimately. Acting on the earlier
    // verdict would delete a live lock and let two rotators run — worse than
    // no lock at all, since both then archive and both then rename.
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "abandoned\n");
    const longAgo = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    let swapped = false;
    env.hooks.onStat = (path) => {
      if (swapped || path !== lockPath) return;
      swapped = true;
      // A different file at the same name: new inode, current mtime.
      unlinkSync(lockPath);
      writeFileSync(lockPath, "someone-else-live\n");
    };

    const before = readFileSync(TRANSCRIPT, "utf-8");
    expect(() => store().get("test")).not.toThrow();
    expect(swapped).toBe(true);

    // The live lock survived untouched...
    expect(readFileSync(lockPath, "utf-8")).toBe("someone-else-live\n");
    // ...we stepped aside instead of rotating alongside its holder...
    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(existsSync(ARCHIVE_JAN)).toBe(false);
    // ...and nothing was left parked under a claim name.
    expect(readdirSync(env.dir).filter((n) => n.includes(".claimed-"))).toEqual([]);
  });

  it("does not steal a live lock that reused the abandoned one's inode", () => {
    // The Linux case. ext4 hands a freed inode straight back to the next
    // create, so the live lock that replaces an abandoned one can carry the
    // SAME dev+ino — which is exactly what the takeover used to compare.
    // Reproduced by construction rather than by luck: the replacement is
    // created with the same content shape but a different token, at the
    // same name, and the identity check must key on the token.
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "abandoned\n");
    const longAgo = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    let swapped = false;
    env.hooks.onStat = (path) => {
      if (swapped || path !== lockPath) return;
      swapped = true;
      // Overwrite IN PLACE: same inode by definition, different token.
      writeFileSync(lockPath, "someone-else-live\n");
    };

    const before = readFileSync(TRANSCRIPT, "utf-8");
    expect(() => store().get("test")).not.toThrow();
    expect(swapped).toBe(true);

    expect(readFileSync(lockPath, "utf-8")).toBe("someone-else-live\n");
    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(readdirSync(env.dir).filter((n) => n.includes(".claimed-"))).toEqual([]);
  });

  it("puts a mistakenly claimed lock back without displacing a newer one", () => {
    // Between "live lock renamed to the claim name" and "put back", the lock
    // path is empty and a THIRD rotator can create its own there. Putting
    // ours back with a rename would silently replace that one.
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "abandoned\n");
    const longAgo = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    let swapped = false;
    env.hooks.onStat = (path) => {
      if (swapped || path !== lockPath) return;
      swapped = true;
      unlinkSync(lockPath);
      writeFileSync(lockPath, "someone-else-live\n");
    };
    env.hooks.onRenamed = (_from, to) => {
      if (to.includes(".claimed-")) writeFileSync(lockPath, "third-rotator\n");
    };

    const before = readFileSync(TRANSCRIPT, "utf-8");
    expect(() => store().get("test")).not.toThrow();

    expect(readFileSync(lockPath, "utf-8")).toBe("third-rotator\n");
    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(readdirSync(env.dir).filter((n) => n.includes(".claimed-"))).toEqual([]);
    expect(logLines.warn.join("\n")).toContain("A newer rotation lock appeared meanwhile");
  });

  it("abandons the install when its lock was taken meanwhile", () => {
    // A rotation that outlived the staleness window, or whose lock was
    // displaced: someone else now holds the lock and is about to install
    // their own rewrite. Installing ours too is the double rotation.
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    env.hooks.onRotateTempWritten = () => {
      writeFileSync(lockPath, "taken-over\n");
    };

    const before = readFileSync(TRANSCRIPT, "utf-8");
    expect(() => store().get("test")).not.toThrow();

    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(readdirSync(env.dir).filter((n) => n.includes(".rotate-tmp"))).toEqual([]);
    expect(logLines.warn.join("\n")).toContain("the rotation lock is no longer ours");
    // And it did not remove the lock it no longer held.
    expect(readFileSync(lockPath, "utf-8")).toBe("taken-over\n");
  });

  it("does not rename over a transcript that was replaced underneath it", () => {
    // `tomo sessions clear` removed the file and the daemon recreated it
    // with a new message while we were rewriting the OLD one. The pinned fd
    // never saw that message; installing our rewrite would erase it.
    env.hooks.onRotateTempWritten = () => {
      unlinkSync(TRANSCRIPT);
      writeFileSync(TRANSCRIPT, JSON.stringify(msg({ content: "written to the new file", seq: 1 })) + "\n");
    };

    expect(() => store().get("test")).not.toThrow();

    expect(contentsOf(activeLines())).toEqual(["written to the new file"]);
    expect(readdirSync(env.dir).filter((n) => n.includes(".rotate-"))).toEqual([]);
    expect(logLines.warn.join("\n")).toContain("the transcript was replaced underneath it");
  });

  it("treats a lock dated in the future as abandoned instead of blocking forever", () => {
    // Clock skew, a restored backup, a file copied with its timestamps. A
    // negative age is never greater than the staleness threshold, so without
    // this the lock is never stale and rotation for that key is disabled
    // permanently — silently, which is how a transcript outgrows every bound
    // this code exists to enforce.
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "from the future\n");
    const later = new Date(Date.now() + 60 * 60_000);
    utimesSync(lockPath, later, later);

    store().get("test");

    expect(contentsOf(activeLines())).toEqual(["now one"]);
    expect(statSync(ARCHIVE_JAN).size).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(logLines.warn.join("\n")).toContain("dated in the future");
  });

  it("drains a write that lands on the old inode after the rename", () => {
    // A writer that opened the path just before the rename still holds the
    // replaced inode, which no path names any more. Its bytes are only
    // reachable through a descriptor.
    let lateFd: number | null = null;
    env.hooks.onRotateTempWritten = () => {
      if (lateFd === null) lateFd = openSync(TRANSCRIPT, "a");
    };
    env.hooks.onRenamed = (from) => {
      if (!from.includes(".rotate-tmp") || lateFd === null) return;
      writeSync(lateFd, JSON.stringify(msg({ content: "landed on the old inode", seq: 4 })) + "\n");
    };

    store().get("test");
    if (lateFd !== null) closeSync(lateFd);

    expect(contentsOf(activeLines())).toEqual(["now one", "landed on the old inode"]);
  });

  it("leaves the transcript untouched when the rewritten file cannot be installed", () => {
    env.hooks.failTempRename = true;

    const before = readFileSync(TRANSCRIPT, "utf-8");
    expect(() => store().get("test")).not.toThrow();

    // Every message still readable, and no half-written temp left behind.
    expect(readFileSync(TRANSCRIPT, "utf-8")).toBe(before);
    expect(readdirSync(env.dir).filter((n) => n.includes(".rotate-"))).toEqual([]);
    expect(logLines.warn.join("\n")).toContain("could not install the rewritten file");
  });

  it("abandons the rotation rather than lose appends it cannot carry across", () => {
    // The splice onto the rewritten file fails (ENOSPC). Renaming anyway
    // would destroy the message that arrived mid-rotation, so the pass is
    // abandoned and the original file — which still holds everything — stays.
    env.hooks.failTempAppend = true;
    env.hooks.onRotateTempWritten = () => {
      appendFileSync(TRANSCRIPT, JSON.stringify(msg({ content: "arrived mid-rotation", seq: 4 })) + "\n");
    };

    expect(() => store().get("test")).not.toThrow();

    expect(contentsOf(activeLines())).toEqual(["jan one", "jan two", "now one", "arrived mid-rotation"]);
    expect(readdirSync(env.dir).filter((n) => n.includes(".rotate-"))).toEqual([]);
    expect(logLines.warn.join("\n")).toContain("Abandoning transcript rotation");

    // And the next pass, with the write working again, still rotates cleanly.
    env.hooks.failTempAppend = false;
    env.hooks.onRotateTempWritten = null;
    store().get("test");
    expect(contentsOf(activeLines())).toEqual(["now one", "arrived mid-rotation"]);
  });

  it("takes over a lock left behind by a crashed rotator", () => {
    const lockPath = `${TRANSCRIPT}.rotate-lock`;
    writeFileSync(lockPath, "999999 crashed\n");
    const longAgo = new Date(Date.now() - 20 * 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    store().get("test");

    expect(contentsOf(activeLines())).toEqual(["now one"]);
    expect(statSync(ARCHIVE_JAN).size).toBeGreaterThan(0);
    expect(existsSync(lockPath)).toBe(false);
  });
});
