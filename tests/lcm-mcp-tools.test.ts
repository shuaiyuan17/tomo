import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same shape blocks.test.ts uses: a tiny fresh tail, so six fixture events are
// not all "still warm" and the 9/8 period is actually eligible.
vi.mock("../src/config.js", () => ({
  config: { lcm: { dailyFreshTail: 1, globalFreshTail: false } },
}));
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildLcmTools } from "../src/mcp/lcm-tools.js";
import { getSdkSessionPath } from "../src/sessions/index.js";
import { getCompactTriggerPath } from "../src/lcm/compact.js";

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function mkEvent(type: "user" | "assistant", parentUuid: string | null, ts: string, text: string) {
  return {
    type,
    uuid: randomUUID(),
    parentUuid,
    timestamp: ts,
    isSidechain: false,
    message: { role: type, content: [{ type: "text", text }] },
  };
}

describe("lcm_rollup tool", () => {
  let root: string;
  let sdkSessionsDir: string;
  let sessionsDir: string;
  let sessionId: string;

  beforeEach(() => {
    root = join(tmpdir(), `tomo-test-lcm-tool-${randomUUID()}`);
    sdkSessionsDir = join(root, "sdk");
    sessionsDir = join(root, "sessions");
    mkdirSync(sdkSessionsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    sessionId = `test-${randomUUID()}`;
    // Two exchanges on 9/8 and one on 9/9: the 9/8 ones are the completed
    // period, the 9/9 one is the live tail that must survive.
    const events: unknown[] = [];
    let parent: string | null = null;
    for (const [ts, text] of [
      ["2026-09-08T16:00:00.000Z", "morning"],
      ["2026-09-08T16:01:00.000Z", "reply one"],
      ["2026-09-08T23:00:00.000Z", "evening"],
      ["2026-09-08T23:01:00.000Z", "reply two"],
      ["2026-09-09T15:00:00.000Z", "next day"],
      ["2026-09-09T15:01:00.000Z", "reply three"],
    ] as const) {
      const ev = mkEvent(text.startsWith("reply") ? "assistant" : "user", parent, ts, text);
      events.push(ev);
      parent = ev.uuid;
    }
    const path = getSdkSessionPath(sessionId, sdkSessionsDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function tool(opts: { noSessionId?: boolean } = {}): ToolHandle {
    const tools = buildLcmTools({
      sdkSessionIdFor: () => (opts.noSessionId ? undefined : sessionId),
      sdkSessionsDir,
      sessionsDir,
      sessionKey: "telegram:-100",
    }) as unknown as ToolHandle[];
    const found = tools.find((t) => t.name === "lcm_rollup");
    if (!found) throw new Error("lcm_rollup not registered");
    return found;
  }

  it("writes the block, archives the period, and leaves the reload trigger — like the CLI", async () => {
    const res = await tool().handler({ level: "daily", period: "2026-09-08", summary: "9/8: two exchanges." }, {});
    expect(res.content[0]!.text, res.content[0]!.text).not.toContain('"error"');
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe("ok");
    expect(body.blockTag).toBe("daily 2026-09-08");
    expect(body.eventsRemoved).toBe(4);

    const lines = readFileSync(getSdkSessionPath(sessionId, sdkSessionsDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const block = lines.find((l) => l.isCompactSummary);
    expect(block?.blockTag).toBe("daily 2026-09-08");
    expect(JSON.stringify(block?.message)).toContain("9/8: two exchanges.");
    // The live tail is untouched.
    expect(lines.some((l) => JSON.stringify(l.message).includes("reply three"))).toBe(true);
    // Same trigger file the CLI writes: the live session reloads on the same path.
    expect(existsSync(getCompactTriggerPath(sessionId, sdkSessionsDir))).toBe(true);
    // The archive holds the originals.
    expect(existsSync(join(sessionsDir, `_archive_${sessionId}.jsonl`))).toBe(true);
  });

  it("reports an error instead of throwing when the period has no events", async () => {
    const res = await tool().handler({ level: "daily", period: "2026-01-01", summary: "nothing" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("No events found for daily 2026-01-01");
  });

  it("refuses when the session has no SDK session id yet", async () => {
    const res = await tool({ noSessionId: true }).handler({ level: "daily", summary: "x" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("no SDK session id");
  });
});
