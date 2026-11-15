import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLineSerial } from "../src/usage/append.js";

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
