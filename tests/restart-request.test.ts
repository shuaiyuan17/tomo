import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESTART_REQUEST_TTL_MS,
  consumeRestartRequestFromToolResult,
  createRestartRequest,
  formatRestartRequestResult,
  drainRestartRequests,
  restartWorkerInvocation,
  sweepStaleRestartRequests,
  takePendingRestartRequest,
} from "../src/restart-request.js";

const DAEMON = 4242;
let requestDir: string;

beforeEach(() => {
  requestDir = join(tmpdir(), `tomo-restart-request-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(requestDir, { recursive: true });
});

afterEach(() => {
  rmSync(requestDir, { recursive: true, force: true });
});

describe("restart request handshake", () => {
  it("consumes a request only after its marker returns in the same session's tool result", () => {
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "config changed" }, requestDir);
    const result = formatRestartRequestResult(request);

    expect(consumeRestartRequestFromToolResult(result, "dm:other", requestDir)).toBeNull();
    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir)).toEqual(request);
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir)).toBeNull();
  });

  it("accepts array-shaped SDK tool-result content", () => {
    const request = createRestartRequest({ sessionKey: "telegram:123", daemonPid: DAEMON, reason: undefined }, requestDir);
    const content = [{ type: "text", text: formatRestartRequestResult(request) }];

    expect(consumeRestartRequestFromToolResult(content, "telegram:123", requestDir)).toEqual(request);
  });

  it("ignores malformed or unrelated output", () => {
    expect(consumeRestartRequestFromToolResult("Restarted", "dm:shuai", requestDir)).toBeNull();
    expect(consumeRestartRequestFromToolResult("TOMO_RESTART_REQUEST:not-an-id", "dm:shuai", requestDir)).toBeNull();
  });

  it("launches the acknowledged worker without the SDK session environment", () => {
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "config changed" }, requestDir);
    const worker = restartWorkerInvocation(request, "/opt/tomo/dist/cli.js", {
      TOMO_SESSION_KEY: "dm:shuai",
      KEEP_ME: "yes",
    });

    expect(worker.command).toBe(process.execPath);
    expect(worker.args).toEqual([
      "/opt/tomo/dist/cli.js",
      "restart",
      "--reason",
      "config changed",
      "--session",
      "dm:shuai",
    ]);
    expect(worker.env).toEqual({ KEEP_ME: "yes" });
  });
});

describe("restart request expiry", () => {
  it("refuses a marker that comes back after the request has expired, and drops the file", () => {
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "config changed" }, requestDir);
    const result = formatRestartRequestResult(request);
    const expired = Date.parse(request.requestedAt) + RESTART_REQUEST_TTL_MS;

    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir, expired)).toBeNull();
    // Dropped, not left to fire on some later turn.
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
  });

  it("still honours a marker just inside the window", () => {
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: undefined }, requestDir);
    const result = formatRestartRequestResult(request);
    const justInside = Date.parse(request.requestedAt) + RESTART_REQUEST_TTL_MS - 1;

    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir, justInside)).toEqual(request);
  });

  it("sweeps expired and malformed requests but keeps live ones", () => {
    const live = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "live" }, requestDir);
    const stale = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "stale" }, requestDir);
    writeFileSync(join(requestDir, "not-json.json"), "{ this is not json");

    // Age only `stale` by rewriting its timestamp.
    writeFileSync(
      join(requestDir, `${stale.id}.json`),
      JSON.stringify({ ...stale, requestedAt: new Date(Date.now() - RESTART_REQUEST_TTL_MS - 1).toISOString() }) + "\n",
    );

    expect(sweepStaleRestartRequests(requestDir, Date.now(), undefined, DAEMON)).toBe(2);
    expect(readdirSync(requestDir)).toEqual([`${live.id}.json`]);
  });

  it("is a no-op when the request directory has never been created", () => {
    expect(sweepStaleRestartRequests(join(requestDir, "nope"), Date.now(), undefined, DAEMON)).toBe(0);
    expect(takePendingRestartRequest("dm:shuai", join(requestDir, "nope"))).toBeNull();
  });
});

describe("end-of-turn restart fallback", () => {
  it("claims a request whose marker never came back", () => {
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "config changed" }, requestDir);

    expect(takePendingRestartRequest("dm:shuai", requestDir)).toEqual(request);
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
    // Claimed once: the restart is already in flight, a second must not queue.
    expect(takePendingRestartRequest("dm:shuai", requestDir)).toBeNull();
  });

  it("leaves other sessions' requests alone", () => {
    const mine = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: undefined }, requestDir);
    const theirs = createRestartRequest({ sessionKey: "telegram:123", daemonPid: DAEMON, reason: undefined }, requestDir);

    expect(takePendingRestartRequest("dm:shuai", requestDir)).toEqual(mine);
    expect(readdirSync(requestDir)).toEqual([`${theirs.id}.json`]);
  });

  it("collapses two requests from one turn into a single restart, keeping the oldest reason", () => {
    const first = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "first" }, requestDir);
    const second = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "second" }, requestDir);
    writeFileSync(
      join(requestDir, `${second.id}.json`),
      JSON.stringify({ ...second, requestedAt: new Date(Date.parse(first.requestedAt) + 1000).toISOString() }) + "\n",
    );

    expect(takePendingRestartRequest("dm:shuai", requestDir)?.reason).toBe("first");
    // The straggler is consumed too — otherwise it fires again after the restart.
    expect(readdirSync(requestDir)).toEqual([]);
  });

  it("still restarts after a turn that ran far longer than the TTL", () => {
    // The regression this exists to prevent: a 12-minute tool loop between the
    // `tomo restart` call and the end of the turn. The CLI already printed
    // "restart scheduled"; wall-clock age is not evidence the owner stopped
    // waiting, and the turn ending IS evidence the request is current.
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "after a long turn" }, requestDir);
    writeFileSync(
      join(requestDir, `${request.id}.json`),
      JSON.stringify({ ...request, requestedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString() }) + "\n",
    );

    expect(takePendingRestartRequest("dm:shuai", requestDir)?.reason).toBe("after a long turn");
    expect(readdirSync(requestDir)).toEqual([]);
  });

  it("reports every discard so a restart never goes missing silently", () => {
    const discards: string[] = [];
    const first = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "first" }, requestDir);
    const second = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "second" }, requestDir);
    writeFileSync(
      join(requestDir, `${second.id}.json`),
      JSON.stringify({ ...second, requestedAt: new Date(Date.parse(first.requestedAt) + 1000).toISOString() }) + "\n",
    );
    writeFileSync(join(requestDir, "not-json.json"), "{ nope");

    const claimed = takePendingRestartRequest("dm:shuai", requestDir, (d) => discards.push(d.reason));

    expect(claimed?.reason).toBe("first");
    // The malformed file, and the second request the claimed one supersedes.
    expect(discards.sort()).toEqual(["malformed", "superseded"]);
  });

  it("reports an expired marker discard rather than dropping it quietly", () => {
    const discards: string[] = [];
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: undefined }, requestDir);
    const result = formatRestartRequestResult(request);
    const expired = Date.parse(request.requestedAt) + RESTART_REQUEST_TTL_MS;

    expect(
      consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir, expired, (d) => discards.push(d.reason)),
    ).toBeNull();
    expect(discards).toEqual(["expired"]);
  });

  it("reports what the startup sweep threw away", () => {
    const discards: string[] = [];
    const stale = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "stale" }, requestDir);
    writeFileSync(
      join(requestDir, `${stale.id}.json`),
      JSON.stringify({ ...stale, requestedAt: new Date(Date.now() - RESTART_REQUEST_TTL_MS - 1).toISOString() }) + "\n",
    );
    writeFileSync(join(requestDir, "not-json.json"), "{ nope");

    expect(sweepStaleRestartRequests(requestDir, Date.now(), (d) => discards.push(d.reason), DAEMON)).toBe(2);
    expect(discards.sort()).toEqual(["expired", "malformed"]);
  });
});

describe("a request belongs to the daemon that filed it", () => {
  it("sweeps a still-fresh request from a previous daemon", () => {
    // The spurious-restart bug: the daemon dies with a request well inside the
    // TTL. Age cannot tell it apart from a live one, so the next daemon's
    // first unrelated turn end would claim it and restart out of nowhere.
    const discards: string[] = [];
    const orphan = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: 111, reason: "before the outage" }, requestDir);

    expect(sweepStaleRestartRequests(requestDir, Date.now(), (d) => discards.push(d.reason), 222)).toBe(1);
    expect(discards).toEqual(["foreign-daemon"]);
    expect(existsSync(join(requestDir, `${orphan.id}.json`))).toBe(false);
  });

  it("sweeps a previous daemon's request for a session that is not even ours to restart", () => {
    // The cross-session half of the same bug: surviving the outage, this would
    // be claimed at some later turn end and restart with another session's
    // older reason.
    createRestartRequest({ sessionKey: "telegram:123", daemonPid: 111, reason: "theirs" }, requestDir);
    expect(sweepStaleRestartRequests(requestDir, Date.now(), undefined, 222)).toBe(1);
    expect(readdirSync(requestDir)).toEqual([]);
  });

  it("keeps this daemon's own fresh requests", () => {
    const mine = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "mine" }, requestDir);
    expect(sweepStaleRestartRequests(requestDir, Date.now(), undefined, DAEMON)).toBe(0);
    expect(readdirSync(requestDir)).toEqual([`${mine.id}.json`]);
  });

  it("treats a request with no usable daemon stamp as malformed", () => {
    const request = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: undefined }, requestDir);
    for (const daemonPid of [undefined, 0, -1, "111", 1.5]) {
      writeFileSync(
        join(requestDir, `${request.id}.json`),
        JSON.stringify({ ...request, daemonPid }) + "\n",
      );
      const discards: string[] = [];
      expect(sweepStaleRestartRequests(requestDir, Date.now(), (d) => discards.push(d.reason), DAEMON)).toBe(1);
      expect(discards).toEqual(["malformed"]);
    }
  });
});

describe("draining reports every request it drops", () => {
  it("reports the one that would have been acted on, not just the extras", () => {
    const discards: Array<{ reason: string; path: string }> = [];
    const first = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "first" }, requestDir);
    const second = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "second" }, requestDir);

    expect(drainRestartRequests("dm:shuai", "superseded", requestDir, (d) => discards.push({ reason: d.reason, path: d.path }))).toBe(2);

    // Both, not one: "nothing is discarded silently" has to include `live[0]`.
    expect(discards.map((d) => d.reason)).toEqual(["superseded", "superseded"]);
    expect(discards.map((d) => d.path).sort()).toEqual(
      [join(requestDir, `${first.id}.json`), join(requestDir, `${second.id}.json`)].sort(),
    );
  });

  it("names a path that actually existed", () => {
    const discards: string[] = [];
    const first = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "first" }, requestDir);
    const second = createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "second" }, requestDir);
    // Pin the order: both can otherwise land in the same millisecond, which
    // makes which one is "oldest" — and so which is reported — a coin flip.
    writeFileSync(
      join(requestDir, `${second.id}.json`),
      JSON.stringify({ ...second, requestedAt: new Date(Date.parse(first.requestedAt) + 1000).toISOString() }) + "\n",
    );

    takePendingRestartRequest("dm:shuai", requestDir, (d) => discards.push(d.path));

    // The superseded extra is reported at the path it was scanned from — the
    // reported path used to be rebuilt from the id, which need not exist.
    expect(discards).toHaveLength(1);
    expect(existsSync(dirname(discards[0]))).toBe(true);
    expect(discards[0].startsWith(requestDir)).toBe(true);
    // It is the SECOND request that was superseded, reported at its own path.
    expect(discards[0]).toBe(join(requestDir, `${second.id}.json`));
    expect(discards[0]).not.toBe(join(requestDir, `${first.id}.json`));
  });

  it("drains under a shutting-down reason without restarting", () => {
    const discards: string[] = [];
    createRestartRequest({ sessionKey: "dm:shuai", daemonPid: DAEMON, reason: "please restart" }, requestDir);

    expect(drainRestartRequests("dm:shuai", "shutting-down", requestDir, (d) => discards.push(d.reason))).toBe(1);
    expect(discards).toEqual(["shutting-down"]);
    expect(readdirSync(requestDir)).toEqual([]);
  });
});

describe("explicit --session attribution", () => {
  it("attributes the reason to the named session while staying claimable by the filing one", () => {
    const request = createRestartRequest({
      sessionKey: "dm:shuai",
      daemonPid: DAEMON,
      reason: "config changed",
      attributedSessionKey: "telegram:123",
    }, requestDir);

    // Claimable by the session that ran the command...
    expect(takePendingRestartRequest("dm:shuai", requestDir)).toEqual(request);
    // ...but the reason is delivered where --session said.
    expect(restartWorkerInvocation(request, "/opt/tomo/dist/cli.js", {}).args).toEqual([
      "/opt/tomo/dist/cli.js", "restart", "--reason", "config changed", "--session", "telegram:123",
    ]);
  });

  it("omits a redundant attribution equal to the filing session", () => {
    const request = createRestartRequest({
      sessionKey: "dm:shuai",
      daemonPid: DAEMON,
      attributedSessionKey: "dm:shuai",
    }, requestDir);

    expect(request.attributedSessionKey).toBeUndefined();
    expect(restartWorkerInvocation(request, "/cli.js", {}).args).toContain("dm:shuai");
  });
});
