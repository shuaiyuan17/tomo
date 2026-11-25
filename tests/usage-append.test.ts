import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLineSerial } from "../src/usage/append.js";

// A line carrying the word "slow" takes 30 ms to write, so an unserialized
// second append would land before it. No other line here carries it.
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, appendFile: async (...args: Parameters<typeof real.appendFile>) => {
    if (String(args[1]).includes("slow")) await new Promise((r) => setTimeout(r, 30));
    return real.appendFile(...args);
  } };
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-append-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("starts a new line after a torn tail instead of gluing onto it (limits.ndjson too)", async () => {
  const path = join(dir, "limits.ndjson");
  writeFileSync(path, '{"v":1,"a":1}\n{"v":1,"tor');
  await appendLineSerial(path, () => '{"v":1,"b":2}');
  await appendLineSerial(path, () => '{"v":1,"c":3}');
  expect(readFileSync(path, "utf8")).toBe('{"v":1,"a":1}\n{"v":1,"tor\n{"v":1,"b":2}\n{"v":1,"c":3}\n');
});

it("adds nothing to a file that already ends in a newline, or to a new one", async () => {
  const intact = join(dir, "intact.ndjson");
  writeFileSync(intact, "x\n");
  await appendLineSerial(intact, () => "y");
  expect(readFileSync(intact, "utf8")).toBe("x\ny\n");
  const fresh = join(dir, "fresh.ndjson");
  await appendLineSerial(fresh, () => "z");
  expect(readFileSync(fresh, "utf8")).toBe("z\n");
});

it("tightens an existing file wider than fileMode before writing into it; without fileMode it is left alone", async () => {
  const wide = join(dir, "2026-09.ndjson");
  writeFileSync(wide, "x\n", { mode: 0o644 });
  await appendLineSerial(wide, () => "y", undefined, { fileMode: 0o600 });
  expect(statSync(wide).mode & 0o777).toBe(0o600);
  expect(readFileSync(wide, "utf8")).toBe("x\ny\n");
  const narrow = join(dir, "narrow.ndjson");
  writeFileSync(narrow, "x\n", { mode: 0o400 | 0o200 });
  await appendLineSerial(narrow, () => "y", undefined, { fileMode: 0o640 });
  expect(statSync(narrow).mode & 0o777).toBe(0o600);
  const other = join(dir, "limits.ndjson");
  writeFileSync(other, "x\n", { mode: 0o644 });
  await appendLineSerial(other, () => "y");
  expect(statSync(other).mode & 0o777).toBe(0o644);
});

it("serializes appends to one file: lines land in call order, even when the first is slow", async () => {
  // limits.ndjson and the month ledgers are written from callers that do not
  // await each other (a turn's result and a /usage read). The second line is
  // also computed only once the first has landed, which is what lets a caller
  // dedup against the last line written.
  const path = join(dir, "limits.ndjson");
  const computedAfter: string[] = [];
  await Promise.all([
    appendLineSerial(path, () => "A slow"),
    appendLineSerial(path, () => { computedAfter.push(readFileSync(path, "utf8")); return "B"; }),
  ]);
  expect(readFileSync(path, "utf8")).toBe("A slow\nB\n");
  expect(computedAfter).toEqual(["A slow\n"]);
});
