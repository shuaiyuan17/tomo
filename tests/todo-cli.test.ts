import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// `tomo todo due` is what a heartbeat script prints: nothing at all on a quiet
// day, at most `--max` items otherwise, and a non-zero exit (not an empty
// list) when the store cannot be read.

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function home(items?: unknown[] | string): string {
  const dir = mkdtempSync(join(tmpdir(), "tomo-test-todo-cli-"));
  scratch.push(dir);
  if (items !== undefined) {
    mkdirSync(join(dir, ".tomo", "data", "todos"), { recursive: true });
    const body = typeof items === "string" ? items : JSON.stringify({ version: 1, next_id: items.length + 1, items });
    writeFileSync(join(dir, ".tomo", "data", "todos", "todos.json"), body);
  }
  return dir;
}

function tomo(homeDir: string, ...args: string[]) {
  return tomoAs(undefined, homeDir, ...args);
}

/** Run as an agent shell would: with the session key tomo puts in its env. */
function tomoAs(sessionKey: string | undefined, homeDir: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  delete env.TOMO_SESSION_KEY;
  if (sessionKey !== undefined) env.TOMO_SESSION_KEY = sessionKey;
  const run = spawnSync(TSX, [CLI, "todo", ...args], { encoding: "utf8", env });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const DAY = 86_400_000;
const item = (n: number, reviewOffsetDays: number, title = `item ${n}`) => ({
  id: `t-${n}`, title, next: "Check it", waiting_on: "me",
  review_at: new Date(Date.now() + reviewOffsetDays * DAY).toISOString(),
  session: n % 2 ? "dm:shuai" : "telegram:-100777",
  created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), source: "self", snoozes: 0,
});

describe("tomo todo due", () => {
  it("prints nothing and exits 0 when there is no store, or nothing is due", { timeout: 30_000 }, () => {
    expect(tomo(home(), "due")).toMatchObject({ code: 0, out: "" });
    expect(tomo(home([item(1, 2)]), "due")).toMatchObject({ code: 0, out: "" });
  });

  it("prints the longest-overdue items, three by default", { timeout: 30_000 }, () => {
    const dir = home([item(1, -1), item(2, -5), item(3, -3), item(4, -4), item(5, 1)]);
    const run = tomo(dir, "due");
    expect(run.code).toBe(0);
    const lines = run.out.trim().split("\n");
    expect(lines[0]).toBe("4 todos due for review. Resolve each with todo_resolve: done, drop, snooze or handoff.");
    expect(lines.slice(1, 4).map((l) => l.split(" ")[0])).toEqual(["t-2", "t-4", "t-3"]);
    expect(lines[4]).toBe("(1 more due)");
    expect(lines).toHaveLength(5);
    expect(tomo(dir, "due", "--max", "1").out.trim().split("\n")).toHaveLength(3);
    // Scoped to a group: only that group's items.
    expect(tomo(dir, "due", "--session", "telegram:-100777").out).toMatch(/^2 todos due[\s\S]*t-2[\s\S]*t-4/);
  });

  it("fails loudly on a corrupt store", { timeout: 30_000 }, () => {
    const run = tomo(home("{ not json"), "due");
    expect(run.code).toBe(1);
    expect(run.out).toBe("");
    expect(run.err).toMatch(/todo store could not be read/);
  });
});

describe("tomo todo from an agent's shell", () => {
  it("is held to the session key in its env: a group never sees the owner's items", { timeout: 30_000 }, () => {
    const dir = home([item(1, -1, "owner secret"), item(2, -1, "group thing"), item(3, -1, "owner other")]);
    for (const args of [["due"], ["list"], ["due", "--session", "dm:shuai"], ["list", "--session", "dm:shuai"]]) {
      const run = tomoAs("telegram:-100777", dir, ...args);
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.out, args.join(" ")).not.toContain("owner");
    }
    expect(tomoAs("telegram:-100777", dir, "list").out).toContain("t-2 group thing");
    // Another group sees nothing at all; due prints nothing.
    expect(tomoAs("telegram:-100999", dir, "due")).toMatchObject({ code: 0, out: "" });
    // The owner's DM shell, and a terminal with no key, see everything.
    for (const run of [tomoAs("dm:shuai", dir, "list"), tomo(dir, "list")]) {
      expect(run.out).toContain("owner secret");
      expect(run.out).toContain("group thing");
    }
  });
});
