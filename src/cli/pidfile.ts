import {
  closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { defaultRuntimePaths } from "../runtime-paths.js";

const PID_FILE = defaultRuntimePaths.pidFile;

/**
 * How long the CLI waits for the daemon to exit, everywhere: `tomo stop`,
 * `tomo restart`, and the LaunchAgent restart in service.ts.
 *
 * 60s, not 10s. A graceful shutdown legitimately takes tens of seconds —
 * `agent.stop()` waits for the in-flight assistant response before closing, and
 * the documented budget is 23-33s. A 10s deadline reports failure on a HEALTHY
 * stop and advises `kill -9`, which destroys the in-flight turn's inbound
 * record and strands the pid file. service.ts already used 60s for exactly this
 * wait; this is that number, shared, so the three paths cannot drift again.
 */
export const DAEMON_STOP_TIMEOUT_MS = 60_000;

/**
 * The single liveness predicate for the whole CLI.
 *
 * `kill(pid, 0)` fails with EPERM when the process exists but belongs to
 * another uid — which is ALIVE, not dead. Treating every error as dead (as
 * three separate copies of this function used to) meant a daemon running as
 * another user was reported gone: `tomo stop` sent no signal, declared success
 * and exited 0 while it kept polling, and `getRunningPid()` deleted its pid
 * file. Do not reintroduce a local copy of this.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * An opaque fingerprint of the process currently holding `pid`: its start time
 * and argv, from `ps`. Null when `ps` is unavailable or the pid is gone.
 *
 * Pids are recycled. Without this, a daemon that was SIGKILLed and whose pid
 * was inherited by some other long-lived process leaves a pid file that
 * `kill(pid, 0)` says is live forever — so `acquirePidFile` refuses to start,
 * permanently, and under `KeepAlive` launchd retries the doomed start on a
 * loop. Start time is what makes the identity unforgeable by reuse: a recycled
 * pid necessarily started later.
 */
export function processIdentity(pid: number): string | null {
  try {
    const res = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const line = res.stdout.trim().replace(/\s+/g, " ");
    return line || null;
  } catch {
    return null;
  }
}

/** What a pid file says. `identity` is null for files written before this format. */
export interface PidFileRecord {
  pid: number;
  identity: string | null;
}

/**
 * Parse a pid file: line 1 is the pid, line 2 (optional) the identity from
 * {@link processIdentity}. The pid stays on its own first line precisely so an
 * older reader doing `Number(first line)` is unaffected.
 */
export function readPidFileRecord(pidFile: string = PID_FILE): PidFileRecord | null {
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf-8");
  } catch {
    return null;
  }
  const [pidLine, identityLine] = raw.split("\n");
  const pid = Number((pidLine ?? "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const identity = (identityLine ?? "").trim();
  return { pid, identity: identity || null };
}

/**
 * True when the process the pid file describes is still the one running.
 *
 * Degrades to plain liveness when no identity was recorded (a legacy pid file)
 * or when `ps` cannot answer — never stricter than the old behaviour, so an
 * environment without `ps` keeps working exactly as before.
 */
export function isRecordedProcessLive(record: PidFileRecord): boolean {
  if (!isPidAlive(record.pid)) return false;
  if (record.identity === null) return true;
  const current = processIdentity(record.pid);
  if (current === null) return true;
  return current === record.identity;
}

/**
 * Poll until `pid` is gone, or `timeoutMs` elapses. Returns true iff the
 * process exited.
 *
 * Signals are asynchronous: `process.kill(pid, "SIGTERM")` returns as soon as
 * the signal is queued, long before the daemon has finished `agent.stop()`
 * (which can take tens of seconds when SIGTERM lands mid-turn) — and returns
 * just the same when the handler never runs at all. Anything reporting
 * "stopped" needs to observe the exit, not the send.
 *
 * The poll uses plain liveness rather than the full identity check: the latter
 * spawns `ps`, and at 100ms intervals over a 60s budget that is 600 processes.
 * Callers that care about pid reuse confirm once, at the end (see
 * `performStopWith`).
 */
export async function waitForExit(
  pid: number,
  timeoutMs = DAEMON_STOP_TIMEOUT_MS,
  pollMs = 100,
  alive: (p: number) => boolean = isPidAlive,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= deadline) return !alive(pid);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * Signal the daemon the pid file describes and wait for it to exit. Resolves
 * once the pid is gone (or was never ours to begin with); throws when it is
 * still the recorded daemon after `timeoutMs`.
 *
 * Deliberately does NOT unlink the pid file. The daemon releases its own claim
 * on exit, and a claim left by a crash is taken over by the next
 * `acquirePidFile`. Unlinking here — as `enableAutostart` used to, right after
 * sending SIGTERM — removed a LIVE daemon's exclusion claim while it was still
 * spending its 23–33s graceful-shutdown budget, so the launchd job bootstrapped
 * immediately afterwards started a second daemon alongside it.
 */
export async function stopRecordedDaemon(
  pidFile: string = PID_FILE,
  deps: {
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    wait?: (pid: number, timeoutMs: number) => Promise<boolean>;
    timeoutMs?: number;
  } = {},
): Promise<{ pid: number; stopped: boolean } | null> {
  const record = readPidFileRecord(pidFile);
  if (record === null || !isRecordedProcessLive(record)) return null;
  const kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const wait = deps.wait ?? ((pid, t) => waitForExit(pid, t));
  const timeoutMs = deps.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS;
  try { kill(record.pid, "SIGTERM"); } catch { /* raced away; the wait settles it */ }
  if (await wait(record.pid, timeoutMs)) return { pid: record.pid, stopped: true };
  // Cheap poll timed out; confirm identity once before calling it wedged.
  if (!isRecordedProcessLive(record)) return { pid: record.pid, stopped: true };
  throw new Error(
    `Tomo (PID ${record.pid}) is still running ${Math.round(timeoutMs / 1000)}s after SIGTERM. `
    + `It may be finishing an in-flight turn — check \`tomo logs -f\`, or force it with: kill -9 ${record.pid}`,
  );
}

/**
 * How long a takeover lock may sit on disk before it is presumed abandoned
 * even when its owner cannot be probed. The critical section it guards is a
 * handful of syscalls — microseconds — so a lock this old belongs to a
 * process that was SIGKILLed inside it. The usual signal is faster: the lock
 * records its owner's pid and a dead owner is reclaimed at once.
 */
const LOCK_STALE_MS = 10_000;
/** How long a contender waits for the lock before giving up. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockDirFor(pidFile: string): string {
  return `${pidFile}.lock`;
}

function readLockOwnerPid(dir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dir, "owner"), "utf-8").split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the directory at `lockDir` off its path — but only if it is still the
 * instance (inode) the caller examined. Returns true if that instance was
 * removed.
 *
 * `rename` is atomic and moves exactly one instance, so this is how a lock
 * can be reclaimed without the ABA race that a plain `rmdir` has: two
 * contenders both stat the same abandoned lock; A removes it, creates its own
 * and enters the critical section; B then executes its already-decided
 * `rmdir` — on A's fresh lock — and enters too. Here B's rename moves A's
 * lock, B sees the inode is not the one it judged, and puts it straight back.
 *
 * Residual window: if a third contender takes the vacated path in the
 * microseconds before B restores, the restore fails and A is inside without a
 * lock. That needs three starters to hit one abandoned lock in the same
 * instant; the ordinary two-party race is closed.
 */
function removeLockInstance(lockDir: string, expectedIno: bigint | number): boolean {
  const graveyard = `${lockDir}.reclaim.${randomUUID()}`;
  try {
    renameSync(lockDir, graveyard);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // someone else got there first
    throw err;
  }
  let ino: bigint | number | null = null;
  try { ino = statSync(graveyard).ino; } catch { /* vanished */ }
  if (ino === expectedIno) {
    rmSync(graveyard, { recursive: true, force: true });
    return true;
  }
  try {
    renameSync(graveyard, lockDir);
  } catch {
    rmSync(graveyard, { recursive: true, force: true });
  }
  return false;
}

/** Reclaim `lockDir` if its owner is dead or it is older than `LOCK_STALE_MS`. True if the caller should retry at once. */
function reclaimAbandonedLock(lockDir: string): boolean {
  let ino: bigint | number;
  let ageMs: number;
  try {
    const st = statSync(lockDir);
    ino = st.ino;
    ageMs = Date.now() - st.mtimeMs;
  } catch {
    return true; // vanished between the failed acquire and the stat: retry now
  }
  const owner = readLockOwnerPid(lockDir);
  const abandoned = (owner !== null && !isPidAlive(owner)) || ageMs > LOCK_STALE_MS;
  if (!abandoned) return false;
  removeLockInstance(lockDir, ino);
  return true;
}

/**
 * Run `fn` with `<pidFile>.lock` held.
 *
 * The lock exists because "read the pid file, judge it stale, unlink it" is a
 * check-then-act, and `link()` alone only makes the PUBLISH atomic. Without
 * it, two starters facing one stale file both judge it stale; A unlinks and
 * publishes, and B — having already decided to unlink — deletes A's live claim
 * and publishes its own. Both start. The same race let a concurrent `tomo
 * status` reap a claim that had just been re-taken. Every mutation of the pid
 * file goes through here so that judgement and unlink are one step.
 *
 * Acquisition is `rename(prepared, lockDir)` where `prepared` is a directory
 * already holding an `owner` file. Onto a non-existent path the rename
 * succeeds atomically; onto an existing non-empty directory it fails with
 * ENOTEMPTY. A lock at the path is therefore never observable as empty (the
 * one case where rename would replace it), and it always names its owner, so
 * a contender can tell an abandoned lock from a busy one without waiting.
 *
 * Returns `undefined` if the lock could not be taken within `LOCK_WAIT_MS`,
 * or if the pid file's directory does not exist (then there is no pid file to
 * guard, and a reader must not create `~/.tomo` as a side effect).
 */
function withPidFileLock<T>(pidFile: string, fn: () => T): T | undefined {
  const lockDir = lockDirFor(pidFile);
  const prepared = `${lockDir}.${process.pid}.${randomUUID()}`;
  try {
    mkdirSync(prepared);
    writeFileSync(join(prepared, "owner"), `${process.pid}\n`);
  } catch (err) {
    rmSync(prepared, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const ino = statSync(prepared).ino; // rename preserves the inode
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  try {
    for (;;) {
      try {
        renameSync(prepared, lockDir);
        held = true;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      }
      if (reclaimAbandonedLock(lockDir)) continue;
      if (Date.now() >= deadline) return undefined;
      sleepSync(LOCK_POLL_MS);
    }
    return fn();
  } finally {
    // Release our own instance only: if `fn` somehow outlived LOCK_STALE_MS
    // and a contender reclaimed us, the path now holds THEIR lock.
    if (held) removeLockInstance(lockDir, ino);
    else rmSync(prepared, { recursive: true, force: true });
  }
}

export type PidFileAcquisition =
  /**
   * We own the pid file. `tookOverStale` is the dead pid whose file we
   * removed, or null when the file simply did not exist.
   */
  | { ok: true; tookOverStale: number | null }
  /**
   * Another live daemon holds it; `holder` is its pid. Null when no holder
   * could be identified: the takeover lock stayed busy for the whole wait
   * budget, or the file was being churned by something outside this module.
   */
  | { ok: false; holder: number | null };

/**
 * Claim the daemon pid file, atomically.
 *
 * This is the whole reason the function exists: `existsSync` + `readFileSync`
 * + `writeFileSync` is a check-then-act with a window between the two halves,
 * and the daemon's window used to be the entire startup sequence (config load,
 * mkdirs, a recursive skills copy, channel construction, `metricsExporter
 * .start()`). A login-time autostart firing while the user runs `tomo start`
 * put two daemons past the check — both long-polling the same bot token, both
 * reading chat.db, both writing the session registry — and the pid file named
 * only one of them, so `tomo stop` orphaned the other permanently.
 *
 * The claim is made by writing the pid into a private temp file and then
 * `link()`ing it into place. `link` fails with EEXIST rather than overwriting,
 * so exactly one racer can win — and, unlike `open(…, "wx")` followed by a
 * separate `write`, the pid file is never observable as an EXISTING BUT EMPTY
 * file. That window is not theoretical: with six processes racing, a loser
 * that read the winner's file between its create and its write saw no pid,
 * concluded "stale", unlinked the live winner's claim and took over. Four of
 * six processes won that way.
 *
 * A file left behind by a crashed daemon (or one whose contents are garbage)
 * is taken over: the recorded process is checked (liveness plus identity) and,
 * if gone, the file is unlinked and the link retried. Judgement and unlink
 * happen under {@link withPidFileLock}: without it two starters that both
 * found the same stale file could both take it over — the second one's
 * already-decided unlink deleted the first one's freshly published claim. The
 * retry loop is still bounded, against a file being churned by something
 * outside this module.
 *
 * Call this as the FIRST action of daemon startup, before any `await`.
 */
export function acquirePidFile(pidFile: string = PID_FILE, pid: number = process.pid): PidFileAcquisition {
  mkdirSync(dirname(pidFile), { recursive: true });
  sweepAbandonedStaging(pidFile);

  const staging = `${pidFile}.${pid}.${randomUUID()}`;
  writeFileSync(staging, `${pid}\n${processIdentity(pid) ?? ""}\n`);

  try {
    const outcome = withPidFileLock(pidFile, (): PidFileAcquisition => {
      let tookOverStale: number | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (publishClaim(staging, pidFile)) return { ok: true, tookOverStale };

        const record = readPidFileRecord(pidFile);
        // `record.pid === pid` is us: a pid file we already own (or one a
        // recycled pid left behind that happens to be ours). Either way it is
        // not a second daemon, so take it over — and do NOT report it as a
        // stale takeover, which would print "left by PID <ourselves>".
        if (record !== null && record.pid !== pid && isRecordedProcessLive(record)) {
          return { ok: false, holder: record.pid };
        }

        tookOverStale = record !== null && record.pid !== pid ? record.pid : null;
        try {
          unlinkSync(pidFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      // Five rounds with no live holder means the file is being churned by
      // something outside this module. Refusing is safer than looping: the
      // caller exits non-zero.
      return { ok: false, holder: null };
    });
    // Could not take the lock: another process has been inside the critical
    // section for longer than the whole wait budget. Refuse rather than start
    // a daemon we cannot prove is alone — and say it was the lock, not a
    // daemon, so the diagnosis does not point at a pid that is not running.
    return outcome ?? { ok: false, holder: null };
  } finally {
    try { unlinkSync(staging); } catch { /* already gone */ }
  }
}

/**
 * Publish `staging` as `pidFile` if and only if `pidFile` does not exist.
 * Returns false when someone else holds it.
 *
 * `link` is the primary because it publishes an already-complete file. Some
 * filesystems refuse hard links (EPERM on certain network mounts, ENOTSUP on
 * exFAT/FAT, EXDEV if TMPDIR semantics ever put the staging file on another
 * device, ENOSYS on exotic kernels). The fallback is `open(…, "wx")` + write,
 * NOT `rename`: rename would happily clobber a LIVE daemon's claim, which is
 * the exact failure this module exists to prevent. The fallback keeps
 * exclusion and gives up only the never-observably-empty property.
 */
function publishClaim(staging: string, pidFile: string): boolean {
  try {
    linkSync(staging, pidFile);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "ENOSYS") {
      throw err;
    }
  }

  try {
    const fd = openSync(pidFile, "wx");
    try {
      writeSync(fd, readFileSync(staging));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Remove `tomo.pid.<pid>.<uuid>` staging files whose owning process is gone.
 *
 * `acquirePidFile` unlinks its own staging file in a `finally`, but a daemon
 * SIGKILLed inside the few microseconds it exists leaves one behind forever,
 * and `~/.tomo` accumulates them across crashes. Best-effort: any error here
 * must not stop a daemon from starting.
 */
function sweepAbandonedStaging(pidFile: string): void {
  try {
    const dir = dirname(pidFile);
    const prefix = `${basename(pidFile)}.`;
    const lockPrefix = `${basename(lockDirFor(pidFile))}.`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const path = join(dir, name);
      if (name.startsWith(lockPrefix)) {
        // `tomo.pid.lock.<pid>.<uuid>` is a prepared lock; `.lock.reclaim.<uuid>`
        // a reclaim in flight. Either is abandoned if its owner is dead or it
        // is old. The live lock itself (`tomo.pid.lock`) is never touched here.
        const tag = name.slice(lockPrefix.length).split(".")[0];
        const owner = Number(tag);
        let old = false;
        try { old = Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS; } catch { continue; }
        const dead = Number.isInteger(owner) && owner > 0 && !isPidAlive(owner);
        if (dead || old) rmSync(path, { recursive: true, force: true });
        continue;
      }
      const owner = Number(name.slice(prefix.length).split(".")[0]);
      if (!Number.isInteger(owner) || owner <= 0 || isPidAlive(owner)) continue;
      try { unlinkSync(path); } catch { /* raced or not ours */ }
    }
  } catch { /* unreadable directory is not a reason to refuse to start */ }
}

/**
 * Drop the pid file — but only if it still names `pid`.
 *
 * The guard matters on the shutdown path: a slow-exiting daemon can still be
 * running its `shutdown()` when its replacement has already acquired the file,
 * and an unconditional `unlink` there would delete the live successor's claim
 * and re-open the double-start hole this module closes.
 */
export function releasePidFile(pidFile: string = PID_FILE, pid: number = process.pid): void {
  try {
    withPidFileLock(pidFile, () => {
      if (readPidFileRecord(pidFile)?.pid !== pid) return;
      unlinkSync(pidFile);
    });
  } catch {
    /* best effort — a missing or unreadable pid file needs no cleanup */
  }
}

/**
 * The record in the pid file if the recorded process is still live; otherwise
 * null, with the stale or garbage file removed — under the same lock the
 * daemon acquires with, so a `tomo status` cannot reap a claim that a starting
 * daemon has just re-taken (the judgement and the unlink are one step).
 *
 * If the lock cannot be taken the file is left alone and reported as it reads:
 * a reader must never delete what it could not examine exclusively.
 */
export function readLivePidFileRecord(pidFile: string = PID_FILE): PidFileRecord | null {
  const result = withPidFileLock(pidFile, (): PidFileRecord | null => {
    const record = readPidFileRecord(pidFile);
    if (record !== null && isRecordedProcessLive(record)) return record;
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    return null;
  });
  if (result !== undefined) return result;
  const record = readPidFileRecord(pidFile);
  return record !== null && isRecordedProcessLive(record) ? record : null;
}
