import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A one-shot hook that fires inside an atomic write, so a test can look at the
 * filesystem at the moment a store is publishing.
 */
const hook = { beforeWrite: null as null | ((path: string) => void) };

vi.mock("../src/fs-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fs-utils.js")>();
  return {
    ...actual,
    writeJsonAtomicSync: (path: string, value: unknown, opts?: { beforeRename?: () => void }) => {
      const fire = hook.beforeWrite;
      hook.beforeWrite = null; // one-shot
      fire?.(path);
      return actual.writeJsonAtomicSync(path, value, opts);
    },
  };
});

const { SessionStore } = await import("../src/sessions/store.js");
const { CronStore } = await import("../src/cron/store.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-store-lock-"));
  hook.beforeWrite = null;
});

afterEach(() => {
  hook.beforeWrite = null;
  rmSync(dir, { recursive: true, force: true });
});

const REGISTRY = () => join(dir, "_sessions.json");
const JOBS = () => join(dir, "cron", "jobs.json");

function registryOnDisk(): { sessions: { channelKey: string; sdkSessionId: string; chatTitle?: string }[] } {
  return JSON.parse(readFileSync(REGISTRY(), "utf-8"));
}

function newSessionStore() {
  return new SessionStore(dir, 20, join(dir, "sdk"));
}

// ---------------------------------------------------------------------------
// In-process: the lock is held for the whole read-modify-write, and the read
// inside it is a real read.
// ---------------------------------------------------------------------------

describe("registry writes under the advisory lock", () => {
  it("holds _sessions.json.lock across the write", () => {
    const store = newSessionStore();
    let heldDuringWrite: boolean | null = null;
    hook.beforeWrite = (path) => {
      if (path === REGISTRY()) heldDuringWrite = existsSync(`${REGISTRY()}.lock`);
    };
    store.setSdkSessionId("telegram:1", "sess-aaaa");
    expect(heldDuringWrite).toBe(true);
    // ...and released afterwards, so the next process is not blocked.
    expect(existsSync(`${REGISTRY()}.lock`)).toBe(false);
  });

  it("does not publish a snapshot older than the file it replaces", () => {
    // The concrete lost update: the daemon holds a registry snapshot, another
    // process rewrites the file, and the daemon's next bookkeeping write
    // republishes its own older copy — restoring a link the other process had
    // just changed. The mtime/size stat cache cannot see the difference when
    // the competing write is the same size inside one mtime tick, which is
    // what this stages; only re-reading under the lock catches it.
    const store = newSessionStore();
    store.setSdkSessionId("telegram:1", "sess-aaaa");

    const before = statSync(REGISTRY());
    const swapped = readFileSync(REGISTRY(), "utf-8").replace("sess-aaaa", "sess-bbbb");
    writeFileSync(REGISTRY(), swapped);
    utimesSync(REGISTRY(), before.atimeMs / 1000, before.mtimeMs / 1000);

    // The write really is invisible to the stat cache — otherwise this test
    // would be passing for the wrong reason.
    const after = statSync(REGISTRY());
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    store.setChatTitle("telegram:1", "Ops");

    const entry = registryOnDisk().sessions.find((e) => e.channelKey === "telegram:1")!;
    expect(entry.sdkSessionId).toBe("sess-bbbb"); // the other writer's change survived
    expect(entry.chatTitle).toBe("Ops");          // ...and ours landed on top of it
  });

  // Two 2s lock waits (see REGISTRY_LOCK_OPTIONS) plus setup.
  it("refuses a link change it cannot serialise, and skips bookkeeping quietly", { timeout: 20_000 }, () => {
    const store = newSessionStore();
    store.setSdkSessionId("telegram:1", "sess-aaaa");

    // Another (live) process is inside its own read-modify-write.
    mkdirSync(`${REGISTRY()}.lock`, { recursive: true });
    writeFileSync(
      join(`${REGISTRY()}.lock`, "owner.other"),
      `${JSON.stringify({ pid: process.pid, ts: Date.now(), host: hostname() })}\n`,
    );
    const before = readFileSync(REGISTRY(), "utf-8");
    try {
      // Link changes are loud: a link invented from an unserialised read
      // orphans a JSONL for good.
      expect(() => store.clearSdkSessionId("telegram:1")).toThrow(/could not acquire the lock/);
      // Bookkeeping never throws — it runs on the inbound and turn-completion
      // paths, where a throw drops a message or fails a good turn.
      expect(() => store.setChatTitle("telegram:1", "Ops")).not.toThrow();
      expect(readFileSync(REGISTRY(), "utf-8")).toBe(before);
    } finally {
      rmSync(`${REGISTRY()}.lock`, { recursive: true, force: true });
    }

    // Once the holder is gone, everything works again.
    store.setChatTitle("telegram:1", "Ops");
    expect(registryOnDisk().sessions[0].chatTitle).toBe("Ops");
  });
});

describe("cron writes under the advisory lock", () => {
  it("holds jobs.json.lock across the read-merge-write", () => {
    const store = new CronStore(JOBS());
    let heldDuringWrite: boolean | null = null;
    hook.beforeWrite = (path) => {
      if (path === JOBS()) heldDuringWrite = existsSync(`${JOBS()}.lock`);
    };
    store.add({ name: "j", schedule: { kind: "every", everyMs: 60_000 }, message: "m", sessionKey: "dm:a" });
    expect(heldDuringWrite).toBe(true);
    expect(existsSync(`${JOBS()}.lock`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Across real processes. The property is cross-process by construction: every
// store API is synchronous, so nothing inside one process can interleave with
// itself.
// ---------------------------------------------------------------------------

const FIXTURE = fileURLToPath(new URL("./fixtures/store-write-race.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface RacerLine { pid: number; index: number; error: string | null }

function race(mode: "cron" | "sessions", path: string, index: number, startAt: number): Promise<RacerLine> {
  const child = spawn(TSX, [FIXTURE, mode, path, String(index), String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("error", reject);
    child.on("exit", () => {
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line) as RacerLine);
      else reject(new Error(`racer ${index} produced no result: ${err}`));
    });
  });
}

const RACERS = 6;

describe("concurrent processes writing the same store", () => {
  it("keeps every session-registry edit", { timeout: 60_000 }, async () => {
    // Each child loads the registry, then all six write at one barrier. The
    // registry is published as a whole-snapshot write with no merge, so
    // without cross-process exclusion the last writer's copy — taken before
    // the others wrote — is what survives, and the rest are simply gone.
    const startAt = Date.now() + 5_000; // room for tsx startup on a loaded machine
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => race("sessions", dir, i, startAt)),
    );
    expect(results.map((r) => r.error)).toEqual(Array(RACERS).fill(null));

    const titles = Object.fromEntries(
      registryOnDisk().sessions.map((e) => [e.channelKey, e.chatTitle]),
    );
    for (let i = 0; i < RACERS; i++) {
      expect(titles[`telegram:${i}`]).toBe(`Title ${i}`);
    }
  });

  it("keeps every cron job added at once", { timeout: 60_000 }, async () => {
    mkdirSync(join(dir, "cron"), { recursive: true });
    const startAt = Date.now() + 5_000;
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) => race("cron", JOBS(), i, startAt)),
    );
    // Not merely "the jobs are there": a save that ran out of optimistic
    // retries used to surface as a thrown StaleWriteError to the CLI user.
    expect(results.map((r) => r.error)).toEqual(Array(RACERS).fill(null));

    const jobs = (JSON.parse(readFileSync(JOBS(), "utf-8")) as { jobs: { name: string }[] }).jobs;
    expect(jobs.map((j) => j.name).sort()).toEqual(
      Array.from({ length: RACERS }, (_, i) => `job-${i}`).sort(),
    );
  });
});
