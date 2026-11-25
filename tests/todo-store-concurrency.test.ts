import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Across real processes (the daemon, a CLI, a web child): every store API is
// synchronous, so nothing inside one process can interleave with itself.

const FIXTURE = fileURLToPath(new URL("./fixtures/todo-write-race.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "tomo-test-todo-race-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

interface RacerLine { pid: number; index: number; id: string | null; error: string | null }

interface Racer {
  /** Settles once the racer has loaded and is spinning on the barrier. */
  ready: Promise<void>;
  /** Its result line, once it has added its todo and exited. */
  result: Promise<RacerLine>;
}

function race(index: number, goFile: string): Racer {
  // HOME points at the scratch dir so importing config cannot reach a real ~/.tomo.
  const child = spawn(TSX, [FIXTURE, DIR, String(index), goFile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: DIR },
  });
  let out = "";
  let err = "";
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const result = new Promise<RacerLine>((resolve, reject) => {
    child.stdout.on("data", (c) => {
      out += String(c);
      if (out.startsWith("ready\n")) markReady();
    });
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("error", reject);
    child.on("exit", () => {
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line) as RacerLine);
      else reject(new Error(`racer ${index} produced no result: ${err}`));
    });
  });
  // A racer that dies before the barrier must fail the test, not hang it.
  result.catch(() => undefined).finally(markReady);
  return { ready, result };
}

const RACERS = 6;

describe("concurrent processes adding todos", () => {
  it("keeps every add, with distinct ids", { timeout: 60_000 }, async () => {
    // A file barrier, not a wall-clock one: release everyone the moment the
    // slowest racer has loaded, however long tsx startup took.
    const goFile = join(DIR, "go");
    const racers = Array.from({ length: RACERS }, (_, i) => race(i, goFile));
    await Promise.all(racers.map((r) => r.ready));
    writeFileSync(goFile, "");
    const results = await Promise.all(racers.map((r) => r.result));
    expect(results.map((r) => r.error)).toEqual(Array(RACERS).fill(null));
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(RACERS);

    const disk = JSON.parse(readFileSync(join(DIR, "todos.json"), "utf-8")) as { next_id: number; items: { id: string; title: string }[] };
    expect(disk.items.map((i) => i.title).sort()).toEqual(Array.from({ length: RACERS }, (_, i) => `racer ${i}`).sort());
    expect(disk.items.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(disk.next_id).toBe(RACERS + 1);
  });
});
