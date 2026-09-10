import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, installAgentTestHooks } from "./helpers/agent-harness.js";
import { mockConfig } from "./helpers/agent-mocks.js";
import { log } from "../src/logger.js";

installAgentTestHooks();

const info = log.info as unknown as ReturnType<typeof vi.fn>;

/** The payloads of the info lines whose message contains `needle`. */
function logged(needle: string): Record<string, unknown>[] {
  return info.mock.calls
    .filter((call) => String(call[1] ?? "").includes(needle))
    .map((call) => call[0] as Record<string, unknown>);
}

describe("the legacy-transcript migration status logged on start", () => {
  it("logs only what the directory can say at start, and the full status later", async () => {
    // `settled`/`deferred` count what THIS process tried and could not finish,
    // and at start it has not tried anything — so logging them here always read
    // "clean" no matter what state the sessions directory was in.
    const dir = mockConfig.sessionsDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dm_a_b.ambiguous-20260301-120000.jsonl"), "");
    writeFileSync(join(dir, "_archive_dm_c_2026-07.legacy-20260901-000000.jsonl"), "");

    vi.useFakeTimers();
    try {
      const agent = new Agent();
      await agent.start();

      const onDisk = logged("what is on disk");
      expect(onDisk).toHaveLength(1);
      expect(Object.keys(onDisk[0]).sort()).toEqual(["ambiguous", "orphans", "sidecars"]);
      expect(onDisk[0].ambiguous).toEqual(["dm_a_b"]);
      expect(onDisk[0].sidecars).toEqual(["_archive_dm_c_2026-07.legacy-20260901-000000.jsonl"]);
      // No canonical `_archive_dm_c_2026-07.jsonl` beside it: an interrupted
      // re-key, which readers cover and an operator should know about.
      expect(onDisk[0].orphans).toEqual(["_archive_dm_c_2026-07.legacy-20260901-000000.jsonl"]);
      expect(logged("Legacy transcript migration status")).toHaveLength(0);

      // …and the full status, once, after the keys that get traffic are touched.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const full = logged("Legacy transcript migration status");
      expect(full).toHaveLength(1);
      expect(full[0].settled).toBe(true);
      expect(full[0].deferred).toEqual([]);
      expect(full[0].ambiguous).toEqual(["dm_a_b"]);

      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(logged("Legacy transcript migration status")).toHaveLength(1);
      await agent.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
