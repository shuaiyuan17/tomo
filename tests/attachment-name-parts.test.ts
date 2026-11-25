import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_COLLISION_ATTEMPTS,
  localDateFolder,
  localTimeStamp,
  sanitize,
  shortGuid,
  splitExt,
  writeWithoutOverwrite,
} from "../src/channels/attachment-write.js";

// The name parts every inbound store builds its paths from. imageStore's names
// are reverse-parsed by isImageFiledFor, so these formats are a contract.
describe("attachment name parts", () => {
  it("formats the local date folder and time stamp zero-padded", () => {
    // Local-time constructor, so the assertion holds in any TZ.
    const d = new Date(2026, 0, 5, 3, 4, 9);
    expect(localDateFolder(d)).toBe("2026-01-05");
    expect(localTimeStamp(d)).toBe("030409");
    const late = new Date(2026, 11, 31, 23, 59, 58);
    expect(localDateFolder(late)).toBe("2026-12-31");
    expect(localTimeStamp(late)).toBe("235958");
  });

  it("sanitize keeps [A-Za-z0-9._-], maps the rest to _, falls back on empty", () => {
    expect(sanitize("aZ09._-", "fb")).toBe("aZ09._-");
    expect(sanitize("a/b c:d", "fb")).toBe("a_b_c_d");
    expect(sanitize("../x", "fb")).toBe(".._x");
    expect(sanitize("é", "fb")).toBe("_");
    expect(sanitize("", "fb")).toBe("fb");
    expect(sanitize(undefined, "fb")).toBe("fb");
  });

  it("shortGuid strips dashes, keeps 8 chars, else 'unknown'", () => {
    expect(shortGuid("ab-cd-ef12-3456789")).toBe("abcdef12");
    expect(shortGuid("abc")).toBe("abc");
    expect(shortGuid("---")).toBe("unknown");
    expect(shortGuid(undefined)).toBe("unknown");
  });
});

describe("splitExt", () => {
  it.each([
    ["a.png", ["a", ".png"]],
    ["a.tar.gz", ["a.tar", ".gz"]], // only the last extension
    ["README", ["README", ""]],
    [".gz", [".gz", ""]], // a leading dot is a name, not an extension
    ["trailing.", ["trailing", "."]],
  ])("%s", (name, parts) => {
    expect(splitExt(name)).toEqual(parts);
  });
});

describe("writeWithoutOverwrite", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-attachment-write-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory and writes under the name it was given", async () => {
    const dir = join(tempDir(), "nested", "day");
    const path = await writeWithoutOverwrite(dir, "IMG_0001.png", Buffer.from("one"));
    expect(path).toBe(join(dir, "IMG_0001.png"));
    expect(readFileSync(path!, "utf-8")).toBe("one");
  });

  it("numbers a colliding name before its extension and keeps the first file", async () => {
    const dir = tempDir();
    await writeWithoutOverwrite(dir, "IMG_0001.png", Buffer.from("one"));
    const second = await writeWithoutOverwrite(dir, "IMG_0001.png", Buffer.from("two"));
    expect(second).toBe(join(dir, "IMG_0001-1.png"));
    expect(readFileSync(join(dir, "IMG_0001.png"), "utf-8")).toBe("one");
    expect(readFileSync(second!, "utf-8")).toBe("two");
  });

  it("returns null once every candidate name is taken, writing nothing", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "f.bin"), "taken");
    for (let i = 1; i <= MAX_COLLISION_ATTEMPTS; i++) writeFileSync(join(dir, `f-${i}.bin`), "taken");

    expect(await writeWithoutOverwrite(dir, "f.bin", Buffer.from("new"))).toBeNull();
    expect(readdirSync(dir)).toHaveLength(MAX_COLLISION_ATTEMPTS + 1);
    expect(readFileSync(join(dir, "f.bin"), "utf-8")).toBe("taken");
  });

  it("propagates a filesystem error that is not a name collision", async () => {
    // A name whose parent directory does not exist: ENOENT from the write
    // itself, which the caller's catch must see rather than a retry loop.
    const dir = tempDir();
    await expect(writeWithoutOverwrite(dir, join("missing", "f.bin"), Buffer.from("x")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
