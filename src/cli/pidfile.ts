import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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

export type PidFileAcquisition =
  /**
   * We own the pid file. `tookOverStale` is the dead pid whose file we
   * removed, or null when the file simply did not exist.
   */
  | { ok: true; tookOverStale: number | null }
  /** Another live daemon holds it; `holder` is its pid. */
  | { ok: false; holder: number };

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
 * is taken over: the recorded pid is probed with `kill(pid, 0)` and, if dead,
 * the file is unlinked and the link retried. The retry loop is bounded because
 * the unlink→link pair is NOT atomic — two processes both finding the same
 * stale file can interleave — and losing that sub-race just means the other
 * one is now the live holder, which the next iteration observes.
 *
 * Call this as the FIRST action of daemon startup, before any `await`.
 */
export function acquirePidFile(pidFile: string = PID_FILE, pid: number = process.pid): PidFileAcquisition {
  let tookOverStale: number | null = null;

  mkdirSync(dirname(pidFile), { recursive: true });
  sweepAbandonedStaging(pidFile);

  const staging = `${pidFile}.${pid}.${randomUUID()}`;
  writeFileSync(staging, `${pid}\n${processIdentity(pid) ?? ""}\n`);

  try {
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
        // Someone else cleaned it up first; the next claim attempt settles it.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // Five rounds with no live holder means another process is churning the
    // same file. Refusing is safer than looping: the caller exits non-zero.
    return { ok: false, holder: readPidFileRecord(pidFile)?.pid ?? 0 };
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
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const owner = Number(name.slice(prefix.length).split(".")[0]);
      if (!Number.isInteger(owner) || owner <= 0 || isPidAlive(owner)) continue;
      try { unlinkSync(join(dir, name)); } catch { /* raced or not ours */ }
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
    if (readPidFileRecord(pidFile)?.pid !== pid) return;
    unlinkSync(pidFile);
  } catch {
    /* best effort — a missing or unreadable pid file needs no cleanup */
  }
}
