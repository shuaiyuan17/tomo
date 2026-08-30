import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESTART_REQUEST_TTL_MS,
  consumeRestartRequestFromToolResult,
  createRestartRequest,
  formatRestartRequestResult,
  restartWorkerInvocation,
  sweepStaleRestartRequests,
  takePendingRestartRequest,
} from "../src/restart-request.js";

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
    const request = createRestartRequest("dm:shuai", "config changed", requestDir);
    const result = formatRestartRequestResult(request);

    expect(consumeRestartRequestFromToolResult(result, "dm:other", requestDir)).toBeNull();
    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir)).toEqual(request);
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir)).toBeNull();
  });

  it("accepts array-shaped SDK tool-result content", () => {
    const request = createRestartRequest("telegram:123", undefined, requestDir);
    const content = [{ type: "text", text: formatRestartRequestResult(request) }];

    expect(consumeRestartRequestFromToolResult(content, "telegram:123", requestDir)).toEqual(request);
  });

  it("ignores malformed or unrelated output", () => {
    expect(consumeRestartRequestFromToolResult("Restarted", "dm:shuai", requestDir)).toBeNull();
    expect(consumeRestartRequestFromToolResult("TOMO_RESTART_REQUEST:not-an-id", "dm:shuai", requestDir)).toBeNull();
  });

  it("launches the acknowledged worker without the SDK session environment", () => {
    const request = createRestartRequest("dm:shuai", "config changed", requestDir);
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
    const request = createRestartRequest("dm:shuai", "config changed", requestDir);
    const result = formatRestartRequestResult(request);
    const expired = Date.parse(request.requestedAt) + RESTART_REQUEST_TTL_MS;

    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir, expired)).toBeNull();
    // Dropped, not left to fire on some later turn.
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
  });

  it("still honours a marker just inside the window", () => {
    const request = createRestartRequest("dm:shuai", undefined, requestDir);
    const result = formatRestartRequestResult(request);
    const justInside = Date.parse(request.requestedAt) + RESTART_REQUEST_TTL_MS - 1;

    expect(consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir, justInside)).toEqual(request);
  });

  it("sweeps expired and malformed requests but keeps live ones", () => {
    const live = createRestartRequest("dm:shuai", "live", requestDir);
    const stale = createRestartRequest("dm:shuai", "stale", requestDir);
    writeFileSync(join(requestDir, "not-json.json"), "{ this is not json");

    // Age only `stale` by rewriting its timestamp.
    writeFileSync(
      join(requestDir, `${stale.id}.json`),
      JSON.stringify({ ...stale, requestedAt: new Date(Date.now() - RESTART_REQUEST_TTL_MS - 1).toISOString() }) + "\n",
    );

    expect(sweepStaleRestartRequests(requestDir)).toBe(2);
    expect(readdirSync(requestDir)).toEqual([`${live.id}.json`]);
  });

  it("is a no-op when the request directory has never been created", () => {
    expect(sweepStaleRestartRequests(join(requestDir, "nope"))).toBe(0);
    expect(takePendingRestartRequest("dm:shuai", join(requestDir, "nope"))).toBeNull();
  });
});

describe("end-of-turn restart fallback", () => {
  it("claims a request whose marker never came back", () => {
    const request = createRestartRequest("dm:shuai", "config changed", requestDir);

    expect(takePendingRestartRequest("dm:shuai", requestDir)).toEqual(request);
    expect(existsSync(join(requestDir, `${request.id}.json`))).toBe(false);
    // Claimed once: the restart is already in flight, a second must not queue.
    expect(takePendingRestartRequest("dm:shuai", requestDir)).toBeNull();
  });

  it("leaves other sessions' requests alone", () => {
    const mine = createRestartRequest("dm:shuai", undefined, requestDir);
    const theirs = createRestartRequest("telegram:123", undefined, requestDir);

    expect(takePendingRestartRequest("dm:shuai", requestDir)).toEqual(mine);
    expect(readdirSync(requestDir)).toEqual([`${theirs.id}.json`]);
  });

  it("collapses two requests from one turn into a single restart, keeping the oldest reason", () => {
    const first = createRestartRequest("dm:shuai", "first", requestDir);
    const second = createRestartRequest("dm:shuai", "second", requestDir);
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
    const request = createRestartRequest("dm:shuai", "after a long turn", requestDir);
    writeFileSync(
      join(requestDir, `${request.id}.json`),
      JSON.stringify({ ...request, requestedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString() }) + "\n",
    );

    expect(takePendingRestartRequest("dm:shuai", requestDir)?.reason).toBe("after a long turn");
    expect(readdirSync(requestDir)).toEqual([]);
  });

  it("reports every discard so a restart never goes missing silently", () => {
    const discards: string[] = [];
    const first = createRestartRequest("dm:shuai", "first", requestDir);
    const second = createRestartRequest("dm:shuai", "second", requestDir);
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
    const request = createRestartRequest("dm:shuai", undefined, requestDir);
    const result = formatRestartRequestResult(request);
    const expired = Date.parse(request.requestedAt) + RESTART_REQUEST_TTL_MS;

    expect(
      consumeRestartRequestFromToolResult(result, "dm:shuai", requestDir, expired, (d) => discards.push(d.reason)),
    ).toBeNull();
    expect(discards).toEqual(["expired"]);
  });

  it("reports what the startup sweep threw away", () => {
    const discards: string[] = [];
    const stale = createRestartRequest("dm:shuai", "stale", requestDir);
    writeFileSync(
      join(requestDir, `${stale.id}.json`),
      JSON.stringify({ ...stale, requestedAt: new Date(Date.now() - RESTART_REQUEST_TTL_MS - 1).toISOString() }) + "\n",
    );
    writeFileSync(join(requestDir, "not-json.json"), "{ nope");

    expect(sweepStaleRestartRequests(requestDir, Date.now(), (d) => discards.push(d.reason))).toBe(2);
    expect(discards.sort()).toEqual(["expired", "malformed"]);
  });
});
