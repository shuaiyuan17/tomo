import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// An outside writer (the owner's editor) that changes the file while a call
// runs, after the version check: here, during the copy of the old version.
const outside = vi.hoisted(() => ({ edit: undefined as undefined | (() => void) }));
vi.mock("../src/memory/history.js", async (orig) => {
  const real = await orig<typeof import("../src/memory/history.js")>();
  return {
    ...real,
    keepOldVersion: (...args: Parameters<typeof real.keepOldVersion>) => {
      const path = real.keepOldVersion(...args);
      outside.edit?.();
      return path;
    },
  };
});

const { MemoryStore } = await import("../src/memory/store.js");
const { memoryVersion } = await import("../src/workspace/memory-index.js");

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "tomo-test-memory-race-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const OWNER = { privateBarred: false, canWrite: true, canWriteCore: true };
let mem: string;
let store: InstanceType<typeof MemoryStore>;
beforeEach(() => {
  mem = join(ROOT, `c-${Math.random().toString(36).slice(2)}`, "memory");
  mkdirSync(mem, { recursive: true });
  store = new MemoryStore({ memoryDir: mem, historyDir: join(mem, "..", "history") });
  outside.edit = undefined;
});
const topic = (body: string) => `---\ndescription: d\n---\n${body}\n`;

describe("an outside edit during a call is not overwritten", () => {
  it("memory_write refuses and leaves the outside edit in place", () => {
    writeFileSync(join(mem, "a.md"), topic("mine"));
    const v = memoryVersion(readFileSync(join(mem, "a.md")));
    outside.edit = () => writeFileSync(join(mem, "a.md"), topic("the editor's"));
    expect(() => store.writeFile(OWNER, "a.md", topic("replacement"), v)).toThrow(/changed since you read it/);
    expect(readFileSync(join(mem, "a.md"), "utf8")).toBe(topic("the editor's"));
  });

  it("memory_delete refuses and leaves the file", () => {
    writeFileSync(join(mem, "a.md"), topic("mine"));
    const v = memoryVersion(readFileSync(join(mem, "a.md")));
    outside.edit = () => writeFileSync(join(mem, "a.md"), topic("the editor's"));
    expect(() => store.delete(OWNER, "a.md", v)).toThrow(/changed since you read it/);
    expect(existsSync(join(mem, "a.md"))).toBe(true);
  });

  it("memory_write \"new\" refuses when the file appears meanwhile", () => {
    writeFileSync(join(mem, "seed.md"), topic("x"));
    // No copy is kept for a new file, so hook the write itself: create the file before the rename.
    const spy = vi.spyOn(store as unknown as { unchanged: (r: unknown, c: unknown) => void }, "unchanged");
    spy.mockImplementationOnce(function (this: unknown, r, c) {
      writeFileSync(join(mem, "b.md"), topic("the editor's"));
      spy.mockRestore();
      return (store as unknown as { unchanged: (r: unknown, c: unknown) => void }).unchanged(r, c);
    });
    expect(() => store.writeFile(OWNER, "b.md", topic("mine"), "new")).toThrow(/changed since you read it/);
    expect(readFileSync(join(mem, "b.md"), "utf8")).toBe(topic("the editor's"));
  });
});

describe("a folder swapped for a link after the path was checked", () => {
  it("is caught where the write lands: a barred turn never writes into private/, nobody writes outside memory/", () => {
    mkdirSync(join(mem, "private"), { recursive: true });
    const { symlinkSync } = process.getBuiltinModule("node:fs");
    symlinkSync(join(mem, "private"), join(mem, "swapped"));
    mkdirSync(join(mem, "..", "outside"), { recursive: true });
    symlinkSync(join(mem, "..", "outside"), join(mem, "away"));
    const placeOk = (store as unknown as { placeOk: (r: { rel: string; abs: string }, a: typeof OWNER) => void }).placeOk.bind(store);
    const barred = { privateBarred: true, canWrite: true, canWriteCore: false };
    expect(() => placeOk({ rel: "swapped/x.md", abs: join(mem, "swapped", "x.md") }, barred)).toThrow(/not available on this turn/);
    expect(() => placeOk({ rel: "swapped/x.md", abs: join(mem, "swapped", "x.md") }, OWNER)).not.toThrow();
    expect(() => placeOk({ rel: "away/x.md", abs: join(mem, "away", "x.md") }, OWNER)).toThrow(/outside memory/);
    // Folders that don't exist yet are judged by the nearest one that does, before anything is created.
    expect(() => placeOk({ rel: "swapped/new/sub/x.md", abs: join(mem, "swapped", "new", "sub", "x.md") }, barred)).toThrow(/not available on this turn/);
  });

  it("a search whose reading ran out of time still searches what it read", () => {
    writeFileSync(join(mem, "a.md"), topic("needle"));
    writeFileSync(join(mem, "b.md"), topic("needle"));
    let t = 0;
    const slow = new MemoryStore({ memoryDir: mem, historyDir: join(mem, "..", "history"), now: () => (t += 200) });
    const { hits, truncated } = slow.search(OWNER, "needle");
    expect(truncated).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
  });
});
