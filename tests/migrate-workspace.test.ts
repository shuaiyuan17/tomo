import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `tomo migrate openclaw` writes the imported conversation into the memory
 * tree and then tells the operator "Tomo will see this conversation in its
 * memory on the next message". It re-derived `~/.tomo/workspace/memory` from
 * `homedir()`, ignoring `TOMO_WORKSPACE` — which `runtime-paths.ts` honours
 * and every reader of memory goes through. On a relocated workspace the import
 * landed somewhere the daemon never looks, and the closing line was false.
 *
 * Both `TOMO_WORKSPACE` and `HOME` are redirected in a hoisted block, before
 * any module under test is imported (`defaultRuntimePaths` is evaluated at
 * module load). Redirecting HOME as well is what keeps this test honest AND
 * safe: on the old code the write goes to the fake home rather than the real
 * `~/.tomo/workspace/memory`.
 */
const env = vi.hoisted(() => {
  const root = `/tmp/tomo-migrate-workspace-${process.pid}`;
  const previous = { home: process.env.HOME, workspace: process.env.TOMO_WORKSPACE };
  // Plain strings, not `join`: a hoisted factory runs before any import.
  process.env.HOME = `${root}/home`;
  process.env.TOMO_WORKSPACE = `${root}/relocated-workspace`;
  return { root, previous, workspaceDir: `${root}/relocated-workspace`, home: `${root}/home` };
});

const { migrateCommand } = await import("../src/cli/migrate.js");

afterAll(() => {
  rmSync(env.root, { recursive: true, force: true });
  if (env.previous.home === undefined) delete process.env.HOME;
  else process.env.HOME = env.previous.home;
  if (env.previous.workspace === undefined) delete process.env.TOMO_WORKSPACE;
  else process.env.TOMO_WORKSPACE = env.previous.workspace;
});

function openclawExport(): string {
  mkdirSync(env.root, { recursive: true });
  const path = join(env.root, "session.jsonl");
  writeFileSync(path, [
    JSON.stringify({
      type: "message",
      id: "1",
      parentId: null,
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "where did the pistachio place move to" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "2",
      parentId: "1",
      timestamp: "2026-08-01T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "two blocks north" }] },
    }),
  ].join("\n") + "\n");
  return path;
}

describe("tomo migrate openclaw", () => {
  it("imports into the workspace TOMO_WORKSPACE names, not ~/.tomo", async () => {
    const source = openclawExport();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });

    await migrateCommand.parseAsync(["openclaw", source], { from: "user" });

    const memoryDir = join(env.workspaceDir, "memory");
    const index = join(memoryDir, "MEMORY.md");
    expect(existsSync(index)).toBe(true);
    expect(readFileSync(index, "utf-8")).toContain("OpenClaw import");

    // The claim the command prints has to be about the directory the daemon
    // actually reads.
    const written = logs.find((l) => l.startsWith("Written to:"));
    expect(written).toBeDefined();
    expect(written).toContain(memoryDir);
    expect(readFileSync(written!.replace("Written to: ", ""), "utf-8")).toContain("pistachio");

    // Nothing in the home-derived location the old code used.
    expect(existsSync(join(env.home, ".tomo", "workspace", "memory"))).toBe(false);

    vi.restoreAllMocks();
  });
});
