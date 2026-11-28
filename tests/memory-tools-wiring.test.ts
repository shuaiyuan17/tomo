import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The memory tools as the tomo-internal server registers them: who gets which,
// and the per-call audience that decides what they reach.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tomo-test-memory-wiring-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const WS = join(ROOT, "workspace");
const MEM = join(WS, "memory");
mkdirSync(join(MEM, "private"), { recursive: true });

vi.mock("../src/config.js", () => ({
  config: { workspaceDir: WS, tomoHome: ROOT, sessionsDir: join(ROOT, "data", "sessions"), sdkSessionsDir: join(ROOT, "sdk"), subsessions: { ownerMessages: "via-main" } },
  TOMO_HOME: ROOT,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());

const { createTomoInternalMcpServer } = await import("../src/mcp/internal-server.js");

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type ToolHandle = { name: string; handler: (args: Record<string, unknown>) => Promise<ToolResult> };

function server(key: string, barred: () => boolean) {
  const agent = {
    isPrivateMemoryBarred: barred,
    isOwnAudienceTurn: () => !barred(),
    scopedCallerKey: (k: string) => k,
    turnOwnerMessages: () => [],
    sdkSessionIdFor: () => undefined,
    subsessions: undefined,
    credentialBroker: undefined,
    permissionBroker: {},
  };
  const tools = (createTomoInternalMcpServer(agent as never, key) as unknown as { tools: ToolHandle[] }).tools;
  const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handler(args);
  return { names: tools.map((t) => t.name), call };
}

const memoryNames = (names: string[]) => names.filter((n) => n.startsWith("memory_"));

describe("memory tools on the tomo-internal server", () => {
  it("the owner's DM gets all eight", () => {
    expect(memoryNames(server("dm:alex", () => false).names)).toHaveLength(8);
  });

  it("a sub-session gets only list, read and search", () => {
    expect(memoryNames(server("task:s1", () => false).names)).toEqual(["memory_list", "memory_read", "memory_search"]);
  });

  it("decides the audience per call: a summoned turn on the owner's DM can't touch private/ or MEMORY.md", async () => {
    writeFileSync(join(MEM, "private", "p.md"), "---\ndescription: P.\n---\nx\n");
    writeFileSync(join(MEM, "MEMORY.md"), "# M\n");
    let summoned = true;
    const s = server("dm:alex", () => summoned);
    const read = await s.call("memory_read", { path: "private/p.md" });
    expect(read.isError).toBe(true);
    const core = await s.call("memory_append", { path: "MEMORY.md", content: "- group line" });
    expect(core.isError).toBe(true);
    expect(readFileSync(join(MEM, "MEMORY.md"), "utf8")).toBe("# M\n");
    // The same server, the owner's own turn next.
    summoned = false;
    expect((await s.call("memory_read", { path: "private/p.md" })).isError).toBeUndefined();
    expect((await s.call("memory_append", { path: "MEMORY.md", content: "- owner line" })).isError).toBeUndefined();
    expect(readFileSync(join(MEM, "MEMORY.md"), "utf8")).toBe("# M\n- owner line\n");
  });

  it("keeps old versions under <tomoHome>/data/memory-history/", async () => {
    writeFileSync(join(MEM, "gone.md"), "---\ndescription: G.\n---\nbye\n");
    const s = server("dm:alex", () => false);
    const listed = (await s.call("memory_list", {})).content[0].text;
    const version = /gone\.md — G\. \(version ([0-9a-f]{12})\)/.exec(listed)![1];
    expect((await s.call("memory_delete", { path: "gone.md", if_version: version })).isError).toBeUndefined();
    expect(existsSync(join(ROOT, "data", "memory-history", "gone.md"))).toBe(true);
  });
});
