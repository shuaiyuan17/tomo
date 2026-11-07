import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { STALE_STAGING_MS, stageExternalMcpServers } from "../src/agent/mcp-config-file.js";

const remote = { type: "http" as const, url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer t" } };

describe("stageExternalMcpServers", () => {
  it("leaves options untouched when there is nothing external to stage", () => {
    const options = { mcpServers: {} };
    const staged = stageExternalMcpServers(options);
    expect(staged.options).toBe(options);
  });

  it("keeps existing extraArgs and adds the staged path", () => {
    const staged = stageExternalMcpServers({ mcpServers: { remote }, extraArgs: { "replay-user-messages": null } });
    try {
      const path = staged.options.extraArgs?.["mcp-config"];
      expect(staged.options.extraArgs?.["replay-user-messages"]).toBeNull();
      expect(typeof path).toBe("string");
      expect(JSON.parse(readFileSync(path as string, "utf8"))).toEqual({ mcpServers: { remote } });
      expect(staged.options.mcpServers).toEqual({});
    } finally {
      staged.dispose();
    }
  });

  it("sweeps staging left behind by a killed process, but not a fresh sibling's", () => {
    const first = stageExternalMcpServers({ mcpServers: { remote } });
    const root = dirname(dirname(first.options.extraArgs?.["mcp-config"] as string));
    first.dispose();

    // Owned by this (live) process, so only age can make them stale.
    const stale = join(root, `tomo-mcp-${process.pid}-teststale`);
    const fresh = join(root, `tomo-mcp-${process.pid}-testfresh`);
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const old = (Date.now() - STALE_STAGING_MS - 60_000) / 1000;
    utimesSync(stale, old, old);

    const second = stageExternalMcpServers({ mcpServers: { remote } });
    try {
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      second.dispose();
      utimesSync(fresh, old, old);
      stageExternalMcpServers({ mcpServers: { remote } }).dispose();
    }
    expect(existsSync(fresh)).toBe(false);
  });

  it("sweeps a fresh staging whose owner process is gone", async () => {
    const { spawnSync } = await import("node:child_process");
    const deadPid = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    const probe = stageExternalMcpServers({ mcpServers: { remote } });
    const root = dirname(dirname(probe.options.extraArgs?.["mcp-config"] as string));
    probe.dispose();

    const orphan = join(root, `tomo-mcp-${deadPid}-testorphan`);
    mkdirSync(orphan, { recursive: true });
    stageExternalMcpServers({ mcpServers: { remote } }).dispose();
    expect(existsSync(orphan)).toBe(false);
  });
});
