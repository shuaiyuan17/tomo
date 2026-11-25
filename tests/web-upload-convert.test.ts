import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ONE_PIXEL_PNG } from "./helpers/png.js";

// convertUpload makes its temp dir under os.tmpdir(): point that at a
// directory of this file's own, so what is left behind can be counted.
const scratch = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  scratch.dir = os.tmpdir();
  return { ...os, tmpdir: () => scratch.dir };
});
const heic = vi.hoisted(() => ({
  hasAlpha: vi.fn<(path: string) => Promise<boolean | null>>(),
  convert: vi.fn<(path: string, format: "jpeg" | "png") => Promise<string | null>>(),
}));
vi.mock("../src/channels/heic.js", () => ({ heicHasAlpha: heic.hasAlpha, convertHeicImage: heic.convert }));

const { convertUpload } = await import("../src/web/uploads.js");
const root = mkdtempSync(join(scratch.dir, "tomo-web-upload-convert-"));
scratch.dir = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The leading bytes sniffImageType reads as HEIC. */
const HEIC = Buffer.concat([Buffer.from("\0\0\0\x18ftypheic", "latin1"), Buffer.alloc(32, 7)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const leftovers = () => readdirSync(root);

beforeEach(() => {
  for (const name of leftovers()) rmSync(join(root, name), { recursive: true, force: true });
  heic.hasAlpha.mockReset().mockResolvedValue(false);
  heic.convert.mockReset();
});

describe("convertUpload (HEIC from the browser)", () => {
  it("returns any other image as it came, without converting or making a temp dir", async () => {
    for (const bytes of [ONE_PIXEL_PNG, JPEG, Buffer.from("not an image")]) expect(await convertUpload(bytes)).toBe(bytes);
    expect(heic.convert).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("converts HEIC to JPEG, or to PNG when it has alpha, and removes every temp file", async () => {
    let n = 0;
    heic.convert.mockImplementation(async (_source, format) => {
      const out = join(root, `converted-${++n}.${format}`);
      writeFileSync(out, `${format} bytes`);
      return out;
    });
    expect((await convertUpload(HEIC)).toString()).toBe("jpeg bytes");
    heic.hasAlpha.mockResolvedValue(true);
    expect((await convertUpload(HEIC)).toString()).toBe("png bytes");
    expect(heic.convert.mock.calls.map(([source, format]) => [source.startsWith(join(root, "tomo-web-heic-")) && source.endsWith("upload.heic"), format])).toEqual([[true, "jpeg"], [true, "png"]]);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["the conversion fails", () => heic.convert.mockResolvedValue(null)],
    ["the converter throws", () => heic.convert.mockRejectedValue(new Error("sips gone"))],
    ["the converted file cannot be read", () => heic.convert.mockResolvedValue(join(root, "never-written.jpg"))],
    ["the alpha probe throws", () => heic.hasAlpha.mockRejectedValue(new Error("probe gone"))],
  ])("keeps the original bytes when %s, and leaves no temp dir", async (_name, arrange) => {
    arrange();
    expect(await convertUpload(HEIC)).toBe(HEIC);
    expect(leftovers()).toEqual([]);
  });
});
