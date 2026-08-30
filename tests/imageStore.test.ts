import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the logger so the intentionally-failing "bad baseDir" test doesn't
// flush a real ERROR line to stderr — pino is async and the line lands at
// unpredictable times relative to vitest's summary, making test output
// look intermittently broken.
vi.mock("../src/logger.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { buildImagePath, findExifOrientation, formatImageMarker, formatStickerMarker, mimeToExt, normalizeJpegBuffer, saveInboundImage } = await import("../src/channels/imageStore.js");

/**
 * Build a minimal JPEG buffer that contains just enough structure for the EXIF
 * parser: SOI + APP1(EXIF) with one IFD0 entry (Orientation), then EOI.
 *
 * `endian` is "BE" (Motorola "MM") or "LE" (Intel "II").
 */
function buildJpegWithOrientation(orientation: number, endian: "BE" | "LE" = "BE"): Buffer {
  // EXIF block contents (after the 6-byte "Exif\0\0" identifier):
  //   2 bytes byte order  "MM" or "II"
  //   2 bytes magic       0x002A
  //   4 bytes IFD0 offset (8 — IFD starts right after this header)
  //   2 bytes n_entries   1
  //   12 bytes entry:     tag=0x0112, type=3 (SHORT), count=1, value=<orientation>(2 bytes) + padding
  //   4 bytes next IFD    0
  const tiff = Buffer.alloc(2 + 2 + 4 + 2 + 12 + 4); // 26 bytes
  let off = 0;
  tiff.write(endian === "BE" ? "MM" : "II", off, "ascii"); off += 2;
  if (endian === "BE") tiff.writeUInt16BE(0x002a, off); else tiff.writeUInt16LE(0x002a, off);
  off += 2;
  if (endian === "BE") tiff.writeUInt32BE(8, off); else tiff.writeUInt32LE(8, off);
  off += 4;
  if (endian === "BE") tiff.writeUInt16BE(1, off); else tiff.writeUInt16LE(1, off);
  off += 2;
  // Entry: tag 0x0112 (Orientation), type 3 (SHORT), count 1
  if (endian === "BE") {
    tiff.writeUInt16BE(0x0112, off);
    tiff.writeUInt16BE(3, off + 2);
    tiff.writeUInt32BE(1, off + 4);
    tiff.writeUInt16BE(orientation, off + 8);
    tiff.writeUInt16BE(0, off + 10);
  } else {
    tiff.writeUInt16LE(0x0112, off);
    tiff.writeUInt16LE(3, off + 2);
    tiff.writeUInt32LE(1, off + 4);
    tiff.writeUInt16LE(orientation, off + 8);
    tiff.writeUInt16LE(0, off + 10);
  }
  // off += 12 (unused — next IFD offset is already zero)

  const exifIdent = Buffer.from("Exif\0\0", "binary");
  const app1Payload = Buffer.concat([exifIdent, tiff]);
  const app1Size = app1Payload.length + 2; // size field counts itself

  const out = Buffer.alloc(2 + 2 + 2 + app1Payload.length + 2);
  let p = 0;
  out.writeUInt8(0xff, p++); out.writeUInt8(0xd8, p++); // SOI
  out.writeUInt8(0xff, p++); out.writeUInt8(0xe1, p++); // APP1
  out.writeUInt16BE(app1Size, p); p += 2;
  app1Payload.copy(out, p); p += app1Payload.length;
  out.writeUInt8(0xff, p); out.writeUInt8(0xd9, p + 1); // EOI
  return out;
}

describe("mimeToExt", () => {
  it("maps common image types", () => {
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(mimeToExt("image/jpg")).toBe("jpg");
    expect(mimeToExt("image/png")).toBe("png");
    expect(mimeToExt("image/gif")).toBe("gif");
    expect(mimeToExt("image/webp")).toBe("webp");
    expect(mimeToExt("image/heic")).toBe("heic");
  });

  it("falls back to subtype for unknown image/*", () => {
    expect(mimeToExt("image/avif")).toBe("avif");
  });

  it("returns bin for non-image or missing", () => {
    expect(mimeToExt(undefined)).toBe("bin");
    expect(mimeToExt("application/pdf")).toBe("bin");
  });
});

describe("buildImagePath", () => {
  it("uses YYYY-MM-DD folder and HHMMSS prefix in local time", () => {
    const d = new Date(2026, 3, 19, 15, 21, 30); // Apr 19 2026 15:21:30 local
    const { dir, filename, fullPath } = buildImagePath("/tmp/workspace", "image/png", {
      sessionKey: "dm_shuai",
      guid: "abcdef12-3456-7890",
      timestamp: d,
    });
    expect(dir).toBe("/tmp/workspace/memory/incoming-images/2026-04-19");
    expect(filename).toBe("152130_dm_shuai_abcdef12.png");
    expect(fullPath).toBe("/tmp/workspace/memory/incoming-images/2026-04-19/152130_dm_shuai_abcdef12.png");
  });

  it("sanitizes sketchy session/guid and falls back", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5); // Jan 02 2026 03:04:05
    const { filename } = buildImagePath("/base", "image/jpeg", {
      sessionKey: "../evil/name",
      guid: undefined,
      timestamp: d,
    });
    expect(filename).toBe("030405_.._evil_name_unknown.jpg");
  });

  it("defaults timestamp to now if omitted", () => {
    const { fullPath } = buildImagePath("/b", "image/png", { sessionKey: "s", guid: "gggggggg" });
    expect(fullPath).toMatch(/\/memory\/incoming-images\/\d{4}-\d{2}-\d{2}\/\d{6}_s_gggggggg\.png$/);
  });
});

describe("saveInboundImage", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "imagestore-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("writes file to disk and returns the path", async () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const written = await saveInboundImage(buffer, "image/png", {
      sessionKey: "dm_shuai",
      guid: "deadbeef-1111-2222-3333-444455556666",
      timestamp: new Date(2026, 3, 19, 15, 21, 30),
    }, base);

    expect(written).toBe(join(base, "memory/incoming-images/2026-04-19/152130_dm_shuai_deadbeef.png"));
    const onDisk = await readFile(written!);
    expect(onDisk.equals(buffer)).toBe(true);
    const st = await stat(written!);
    expect(st.size).toBe(buffer.length);
  });

  it("returns null and does not throw on bad baseDir", async () => {
    const buffer = Buffer.from("hello");
    // A file path (not a directory) as baseDir: mkdir-recursive will fail on the parent chain
    // because \0 isn't allowed in paths on macOS/Linux.
    const badBase = "/dev/null/\0invalid";
    const written = await saveInboundImage(buffer, "image/jpeg", { sessionKey: "s", guid: "g" }, badBase);
    expect(written).toBeNull();
  });
});

describe("findExifOrientation", () => {
  it("reads orientation from a big-endian JPEG", () => {
    const buf = buildJpegWithOrientation(6, "BE");
    const found = findExifOrientation(buf);
    expect(found).not.toBeNull();
    expect(found!.orientation).toBe(6);
    expect(found!.endian).toBe("BE");
  });

  it("reads orientation from a little-endian JPEG", () => {
    const buf = buildJpegWithOrientation(8, "LE");
    const found = findExifOrientation(buf);
    expect(found).not.toBeNull();
    expect(found!.orientation).toBe(8);
    expect(found!.endian).toBe("LE");
  });

  it("returns null for a non-JPEG buffer", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(findExifOrientation(png)).toBeNull();
  });

  it("returns null for a JPEG without an EXIF segment", () => {
    // SOI + EOI only
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(findExifOrientation(buf)).toBeNull();
  });

  it("returns null for a truncated buffer", () => {
    expect(findExifOrientation(Buffer.from([0xff]))).toBeNull();
    expect(findExifOrientation(Buffer.alloc(0))).toBeNull();
  });
});

describe("normalizeJpegBuffer", () => {
  it("returns the same buffer for non-JPEG mime types", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const out = await normalizeJpegBuffer(buf, "image/png");
    expect(out).toBe(buf);
  });

  it("returns the same buffer when orientation is 1", async () => {
    const buf = buildJpegWithOrientation(1);
    const out = await normalizeJpegBuffer(buf, "image/jpeg");
    expect(out).toBe(buf);
  });

  it("returns the same buffer when no EXIF segment is present", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI only
    const out = await normalizeJpegBuffer(buf, "image/jpeg");
    expect(out).toBe(buf);
  });

  it("returns original buffer on corrupt JPEG without throwing", async () => {
    // SOI + APP1 with garbage length
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0xff]);
    const out = await normalizeJpegBuffer(buf, "image/jpeg");
    expect(out).toBe(buf);
  });

  // The end-to-end "orientation 6 → rotated + patched to 1" path requires sips
  // and a real JPEG; it's covered manually on real iPhone photos and indirectly
  // through the saveInboundImage integration test on Mac CI.
});

describe("formatStickerMarker", () => {
  it("returns empty for zero stickers", () => {
    expect(formatStickerMarker(0, [])).toBe("");
  });

  it("names a sticker without a saved path (no resend hint without a copy)", () => {
    expect(formatStickerMarker(1, [])).toBe("[Sent a sticker]");
  });

  it("includes the saved path and the STICKER: resend hint", () => {
    expect(formatStickerMarker(1, ["/abs/s.png"])).toBe(
      "[Sent a sticker, saved to: /abs/s.png; resend with STICKER:<saved path>]",
    );
  });

  it("pluralizes multiple stickers", () => {
    expect(formatStickerMarker(2, ["/abs/a.png", "/abs/b.png"])).toBe(
      "[Sent 2 stickers, saved to: /abs/a.png, /abs/b.png; resend with STICKER:<saved path>]",
    );
  });
});


describe("unconverted-attachment note on the inline markers", () => {
  // A HEIC whose sips conversion failed (or was killed at its deadline) is
  // still delivered — with the ORIGINAL bytes, which the harness image reader
  // cannot display. Saying so is the difference between "the agent can't see
  // it and doesn't know why" and a usable message.
  it("is absent when everything converted", () => {
    expect(formatImageMarker(1, ["/abs/a.jpg"])).toBe("[Sent an image, saved to: /abs/a.jpg]");
    expect(formatImageMarker(1, ["/abs/a.jpg"], 0)).toBe("[Sent an image, saved to: /abs/a.jpg]");
    expect(formatImageMarker(1, [])).toBe("[Sent an image]");
  });

  it("appends the note to the image marker, with and without saved paths", () => {
    expect(formatImageMarker(1, ["/abs/a.heic"], 1)).toBe(
      "[Sent an image, saved to: /abs/a.heic; 1 attachment could not be converted from HEIC"
      + " — the original bytes are attached and may not be readable]",
    );
    expect(formatImageMarker(2, [], 2)).toBe(
      "[Sent 2 images; 2 attachments could not be converted from HEIC"
      + " — the original bytes are attached and may not be readable]",
    );
  });

  it("appends the note to the sticker marker before the resend hint", () => {
    expect(formatStickerMarker(1, ["/abs/s.heic"], 1)).toBe(
      "[Sent a sticker, saved to: /abs/s.heic; 1 attachment could not be converted from HEIC"
      + " — the original bytes are attached and may not be readable; resend with STICKER:<saved path>]",
    );
  });

  it("leaves the existing marker shapes untouched (no third argument)", () => {
    expect(formatStickerMarker(2, ["/abs/a.png", "/abs/b.png"])).toBe(
      "[Sent 2 stickers, saved to: /abs/a.png, /abs/b.png; resend with STICKER:<saved path>]",
    );
  });
});
