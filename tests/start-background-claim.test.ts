import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitBackgroundClaim } from "../src/cli/start.js";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tomo-bg-claim-"));
  pidFile = join(dir, "tomo.pid");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const never = new Promise<number | null>(() => {});

// `tomo start` (background) used to print "started" the instant it had
// spawned; the child's pid-file refusal went to tomo.err and both of two
// concurrent starts reported success. The parent now waits for evidence.
describe("awaitBackgroundClaim", () => {
  it("resolves claimed once the pid file names the child", async () => {
    const p = awaitBackgroundClaim({ pidFile, childPid: 777, exited: never, pollMs: 10, timeoutMs: 5_000 });
    setTimeout(() => writeFileSync(pidFile, "777\nidentity\n"), 50);
    expect(await p).toEqual({ kind: "claimed" });
  });

  it("does not accept a pid file naming someone else", async () => {
    writeFileSync(pidFile, "1\n");
    const res = await awaitBackgroundClaim({ pidFile, childPid: 777, exited: never, pollMs: 10, timeoutMs: 200 });
    expect(res.kind).toBe("timeout");
  });

  it("reports the exit code when the child dies before claiming", async () => {
    const exited = new Promise<number | null>((r) => setTimeout(() => r(1), 30));
    const res = await awaitBackgroundClaim({ pidFile, childPid: 777, exited, pollMs: 10, timeoutMs: 5_000 });
    expect(res).toEqual({ kind: "exited", code: 1 });
  });

  it("still reports claimed when the child claimed and then exited", async () => {
    writeFileSync(pidFile, "777\n");
    const res = await awaitBackgroundClaim({ pidFile, childPid: 777, exited: Promise.resolve(0), pollMs: 10, timeoutMs: 1_000 });
    expect(res).toEqual({ kind: "claimed" });
  });

  it("times out with the waited duration", async () => {
    const res = await awaitBackgroundClaim({ pidFile, childPid: 777, exited: never, pollMs: 10, timeoutMs: 120 });
    expect(res.kind).toBe("timeout");
    if (res.kind === "timeout") expect(res.waitedMs).toBeGreaterThanOrEqual(120);
  });
});
