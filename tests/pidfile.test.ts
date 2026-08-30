import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquirePidFile, releasePidFile, isPidAlive, processIdentity, readPidFileRecord,
  isRecordedProcessLive, readLivePidFileRecord, stopRecordedDaemon, waitForExit, DAEMON_STOP_TIMEOUT_MS,
} from "../src/cli/pidfile.js";
import { getRunningPid } from "../src/cli/status-info.js";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-pidfile-"));
  pidFile = join(dir, "tomo.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a process that exits immediately. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

describe("acquirePidFile", () => {
  it("creates the pid file and records our pid on the first line", () => {
    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: true, tookOverStale: null });
    // Line 1 is the bare pid, deliberately: any reader still doing
    // `Number(firstLine)` keeps working across the format change.
    expect(readFileSync(pidFile, "utf-8").split("\n")[0]).toBe("4242");
    expect(readPidFileRecord(pidFile)).toEqual({ pid: 4242, identity: null });
  });

  it("records this process's identity when claiming for a live pid", () => {
    acquirePidFile(pidFile, process.pid);
    const record = readPidFileRecord(pidFile)!;
    expect(record.pid).toBe(process.pid);
    expect(record.identity).toBe(processIdentity(process.pid));
    expect(record.identity).not.toBeNull();
  });

  it("creates the containing directory", () => {
    const nested = join(dir, "a", "b", "tomo.pid");
    expect(acquirePidFile(nested, 7).ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it("refuses when a LIVE process already holds the file", () => {
    // Our own pid is the most reliably-live pid available.
    writeFileSync(pidFile, String(process.pid));
    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: false, holder: process.pid });
    // …and the incumbent's claim is left intact.
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
  });

  it("takes over a stale pid file, reporting the dead pid", () => {
    const dead = deadPid();
    expect(isPidAlive(dead)).toBe(false);
    writeFileSync(pidFile, String(dead));

    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: true, tookOverStale: dead });
    expect(readPidFileRecord(pidFile)).toEqual({ pid: 4242, identity: null });
  });

  it("takes over an unparseable pid file", () => {
    writeFileSync(pidFile, "not-a-pid\n");
    const result = acquirePidFile(pidFile, 4242);
    expect(result).toEqual({ ok: true, tookOverStale: null });
    expect(readPidFileRecord(pidFile)).toEqual({ pid: 4242, identity: null });
  });

  it("takes over a file that already names us WITHOUT calling it a stale takeover", () => {
    // Reporting `tookOverStale: <our own pid>` made startup print "Removed a
    // stale PID file left by PID <ourselves>", which is nonsense.
    writeFileSync(pidFile, String(process.pid));
    expect(acquirePidFile(pidFile, process.pid)).toEqual({ ok: true, tookOverStale: null });
  });

  it("reads a legacy single-line pid file written before the identity format", () => {
    writeFileSync(pidFile, String(process.pid));
    expect(readPidFileRecord(pidFile)).toEqual({ pid: process.pid, identity: null });
    // No identity recorded -> fall back to plain liveness, i.e. old behaviour.
    expect(isRecordedProcessLive({ pid: process.pid, identity: null })).toBe(true);
    expect(acquirePidFile(pidFile, 4242)).toEqual({ ok: false, holder: process.pid });
  });

  it("sweeps staging files abandoned by dead processes, keeping live ones", () => {
    const dead = deadPid();
    const abandoned = `${pidFile}.${dead}.deadbeef`;
    const live = `${pidFile}.${process.pid}.cafebabe`;
    writeFileSync(abandoned, "junk");
    writeFileSync(live, "junk");

    acquirePidFile(pidFile, 4242);

    // A daemon SIGKILLed inside the microseconds its staging file exists
    // leaves one behind forever; ~/.tomo accumulated them across crashes.
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(live)).toBe(true);
    rmSync(live, { force: true });
  });
});

describe("the takeover lock", () => {
  it("reclaims a lock abandoned by a process killed inside the critical section", () => {
    const lockDir = `${pidFile}.lock`;
    mkdirSync(lockDir);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, old, old);
    const res = acquirePidFile(pidFile, 4242);
    expect(res).toEqual({ ok: true, tookOverStale: null });
    expect(existsSync(lockDir)).toBe(false);
  });

  it("does not leave the lock behind after any outcome", () => {
    writeFileSync(pidFile, `${process.pid}\n${processIdentity(process.pid)}\n`);
    expect(acquirePidFile(pidFile, 4242).ok).toBe(false);
    expect(existsSync(`${pidFile}.lock`)).toBe(false);
    releasePidFile(pidFile, process.pid);
    expect(existsSync(`${pidFile}.lock`)).toBe(false);
    expect(readLivePidFileRecord(pidFile)).toBeNull();
    expect(existsSync(`${pidFile}.lock`)).toBe(false);
  });
});

describe("readLivePidFileRecord", () => {
  it("returns the record for a live daemon and reaps a stale one", () => {
    writeFileSync(pidFile, `${process.pid}\n${processIdentity(process.pid)}\n`);
    expect(readLivePidFileRecord(pidFile)?.pid).toBe(process.pid);
    expect(existsSync(pidFile)).toBe(true);
    writeFileSync(pidFile, `${deadPid()}\n`);
    expect(readLivePidFileRecord(pidFile)).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
  });
});

describe("liveness: EPERM is alive, not dead", () => {
  // Three copies of this predicate used to disagree about EPERM, so a daemon
  // owned by another uid read as dead: `tomo stop` sent no signal and reported
  // success, and getRunningPid deleted a LIVE daemon's pid file.
  const root = process.getuid?.() === 0;

  it.skipIf(root)("treats a process we may not signal (pid 1) as alive", () => {
    // pid 1 is launchd, owned by root: kill(1, 0) raises EPERM for us.
    let code: string | undefined;
    try { process.kill(1, 0); } catch (err) { code = (err as NodeJS.ErrnoException).code; }
    expect(code).toBe("EPERM");         // the precondition this test needs
    expect(isPidAlive(1)).toBe(true);   // ...and we call it alive
  });

  it.skipIf(root)("does not reap the pid file of a daemon owned by another user", () => {
    writeFileSync(pidFile, "1\n");
    expect(getRunningPid(pidFile)).toBe(1);
    expect(existsSync(pidFile)).toBe(true);
  });

  it.skipIf(root)("refuses to start against a cross-uid holder", () => {
    writeFileSync(pidFile, "1\n");
    expect(acquirePidFile(pidFile, 4242)).toEqual({ ok: false, holder: 1 });
  });
});

describe("pid reuse", () => {
  // A SIGKILLed daemon whose pid is inherited by some other long-lived process
  // used to pin `acquirePidFile` into refusing forever — and under launchd
  // KeepAlive that is a relaunch loop, not a one-off.
  const foreignIdentity = "Thu Jan  1 00:00:00 1970 /some/other/process --that-is-not-tomo";

  it("recognises that the pid is alive but is no longer the recorded process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isRecordedProcessLive({ pid: process.pid, identity: foreignIdentity })).toBe(false);
  });

  it("takes over a pid file whose pid was recycled", () => {
    writeFileSync(pidFile, `${process.pid}\n${foreignIdentity}\n`);
    expect(acquirePidFile(pidFile, 4242)).toEqual({ ok: true, tookOverStale: process.pid });
  });

  it("reaps a recycled-pid file rather than reporting a running daemon", () => {
    writeFileSync(pidFile, `${process.pid}\n${foreignIdentity}\n`);
    expect(getRunningPid(pidFile)).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("still trusts the pid when the recorded identity matches", () => {
    writeFileSync(pidFile, `${process.pid}\n${processIdentity(process.pid)}\n`);
    expect(getRunningPid(pidFile)).toBe(process.pid);
  });
});

describe("processIdentity", () => {
  it("fingerprints a live process and returns null for a dead one", () => {
    const mine = processIdentity(process.pid);
    expect(mine).toBeTruthy();
    expect(mine).toContain("node");          // our own argv
    expect(processIdentity(deadPid())).toBeNull();
  });
});

describe("the stop budget", () => {
  it("is long enough for a graceful shutdown", () => {
    // agent.stop() waits for the in-flight assistant response; the documented
    // budget is 23-33s. A 10s deadline reported failure on a HEALTHY stop and
    // advised `kill -9`, destroying the in-flight turn's inbound record.
    expect(DAEMON_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(33_000);
    expect(DAEMON_STOP_TIMEOUT_MS).toBe(60_000);
  });
});

describe("releasePidFile", () => {
  it("removes the file when it names us", () => {
    acquirePidFile(pidFile, 4242);
    releasePidFile(pidFile, 4242);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("leaves a successor's claim alone", () => {
    // A slow-exiting daemon must not delete the pid file its replacement has
    // already acquired — that would re-open the double-start hole.
    writeFileSync(pidFile, "999");
    releasePidFile(pidFile, 4242);
    expect(readFileSync(pidFile, "utf-8")).toBe("999");
  });

  it("is a no-op when the file is gone", () => {
    expect(() => releasePidFile(pidFile, 4242)).not.toThrow();
  });
});

const FIXTURE = fileURLToPath(new URL("./fixtures/pidfile-race.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface RacerLine { pid: number; ok: boolean; holder?: number; tookOverStale?: number | null }

interface Racer { result: Promise<RacerLine>; child: ReturnType<typeof spawn> }

/** Start one racer child; its `result` settles on the JSON line it prints. */
function race(startAt: number): Racer {
  const child = spawn(TSX, [FIXTURE, pidFile, String(startAt)], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const result = new Promise<RacerLine>((resolve, reject) => {
    child.stdout.on("data", (c) => {
      out += String(c);
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line));
    });
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("error", reject);
    child.on("exit", () => {
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line));
      else reject(new Error(`racer produced no result: ${err}`));
    });
  });
  return { result, child };
}

describe("acquirePidFile across real processes", () => {
  // The property under test is cross-process, so it cannot be observed in a
  // single process: `acquirePidFile` is synchronous, so an in-process "race"
  // is always serialised. Six real children hitting a shared time barrier
  // exercise the actual create/EEXIST boundary in the kernel.
  it("lets exactly one of six concurrent processes win", { timeout: 60_000 }, async () => {
    const startAt = Date.now() + 5_000; // room for tsx startup on a loaded machine
    const racers = Array.from({ length: 6 }, () => race(startAt));
    try {
      const results = await Promise.all(racers.map((r) => r.result));

      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);

      // Every loser must name the winner — not 0, not each other. A loser that
      // reported a different holder would mean two daemons believed they were
      // alone.
      const winnerPid = winners[0].pid;
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser.holder).toBe(winnerPid);
      }
    } finally {
      // Only now: the winner holds the file until its stdin closes, so no
      // late-starting racer can inherit a stale file and legitimately win too.
      for (const r of racers) { r.child.stdin?.end(); r.child.kill("SIGKILL"); }
    }
  });
});

describe("acquirePidFile across real processes, over a shared STALE file", () => {
  // The dangerous case is not an empty slot but a stale file every racer
  // judges takeable at once: without the takeover lock, the second racer's
  // already-decided unlink deletes the first racer's freshly published claim
  // and both "win".
  it("lets exactly one of six concurrent processes take it over", { timeout: 60_000 }, async () => {
    const stale = deadPid();
    writeFileSync(pidFile, `${stale}\n`);
    const startAt = Date.now() + 5_000;
    const racers = Array.from({ length: 6 }, () => race(startAt));
    try {
      const results = await Promise.all(racers.map((r) => r.result));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      expect(winners[0].tookOverStale).toBe(stale);
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser.holder).toBe(winners[0].pid);
      }
      expect(readPidFileRecord(pidFile)?.pid).toBe(winners[0].pid);
    } finally {
      for (const r of racers) { r.child.stdin?.end(); r.child.kill("SIGKILL"); }
    }
  });
});

describe("stopRecordedDaemon", () => {
  const children: ReturnType<typeof spawn>[] = [];
  afterEach(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } } });

  /** Spawn a child and resolve its pid only once it has printed "ready" — i.e. after its handlers are installed. */
  function child(script: string): Promise<number> {
    const c = spawn(process.execPath, ["-e", `${script}; process.stdout.write("ready\\n");`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(c);
    return new Promise((resolve) => c.stdout!.once("data", () => resolve(c.pid!)));
  }

  it("is a no-op on a stale file and leaves it for the next acquirer", async () => {
    writeFileSync(pidFile, `${deadPid()}\n`);
    expect(await stopRecordedDaemon(pidFile)).toBeNull();
    expect(existsSync(pidFile)).toBe(true);
  });

  it("waits for a cooperative daemon and does not unlink its claim itself", async () => {
    const pid = await child(`process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000)`);
    writeFileSync(pidFile, `${pid}\n${processIdentity(pid)}\n`);
    const res = await stopRecordedDaemon(pidFile, { wait: (p, t) => waitForExit(p, t, 50) });
    expect(res).toEqual({ pid, stopped: true });
    expect(isPidAlive(pid)).toBe(false);
    // Releasing the claim is the daemon's job (or the next acquirer's).
    expect(existsSync(pidFile)).toBe(true);
  });

  it("throws rather than report a daemon that ignores SIGTERM as stopped", async () => {
    const pid = await child(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`);
    writeFileSync(pidFile, `${pid}\n${processIdentity(pid)}\n`);
    await expect(stopRecordedDaemon(pidFile, { timeoutMs: 500, wait: (p, t) => waitForExit(p, t, 50) }))
      .rejects.toThrow(`kill -9 ${pid}`);
    expect(isPidAlive(pid)).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
  });
});

describe("LaunchAgent respawn throttle", () => {
  it("pairs KeepAlive with a ThrottleInterval", async () => {
    // KeepAlive + launchd's 10s default means a deterministically-failing
    // start (pid file held by a recycled pid, uncaught exception on a bad
    // config, metrics port already bound) relaunches six times a minute
    // forever. The throttle bounds the loop without slowing real recovery.
    const { buildPlist } = await import("../src/cli/service.js");
    const plist = buildPlist();
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });
});
