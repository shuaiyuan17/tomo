import { describe, it, expect } from "vitest";
import { buildPlist, LAUNCH_AGENT_EXIT_TIMEOUT_SEC } from "../src/cli/service.js";
import { DAEMON_STOP_TIMEOUT_MS } from "../src/cli/pidfile.js";

describe("LaunchAgent respawn throttle", () => {
  it("pairs KeepAlive with a ThrottleInterval", () => {
    // KeepAlive + launchd's 10s default means a deterministically-failing
    // start (pid file held by a recycled pid, uncaught exception on a bad
    // config, metrics port already bound) relaunches six times a minute
    // forever. The throttle bounds the loop without slowing real recovery.
    const plist = buildPlist();
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });

  it("gives the daemon its full bounded shutdown before launchd SIGKILLs it", () => {
    // launchd's default ExitTimeOut is 20s. Tomo's graceful shutdown is
    // bounded at ~33s, so without this key every `launchctl bootout`, every
    // restart through launchd, and every logout SIGKILLed the daemon
    // mid-flush — after the registry save had started and before the
    // transcript was written.
    expect(LAUNCH_AGENT_EXIT_TIMEOUT_SEC).toBe(Math.ceil(DAEMON_STOP_TIMEOUT_MS / 1000));
    expect(LAUNCH_AGENT_EXIT_TIMEOUT_SEC).toBeGreaterThanOrEqual(33);
    expect(buildPlist()).toMatch(
      new RegExp(`<key>ExitTimeOut</key>\\s*<integer>${LAUNCH_AGENT_EXIT_TIMEOUT_SEC}</integer>`),
    );
  });
});
