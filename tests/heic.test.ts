import { describe, it, expect } from "vitest";
import { isHeicMimeType, hasHeicExtension, sniffHeic, looksLikeHeic } from "../src/channels/heic.js";

// A real iPhone HEIC header: `....ftypheic....mif1MiHE...` (from a 2026-07-07
// dogfood group photo). Only the leading ftyp box matters for detection.
const HEIC_HEADER = Buffer.from(
  "00000024667479706865696300000000" + "6d696631" + "4d694845" + "6d696166",
  "hex",
);
const JPEG_HEADER = Buffer.from("ffd8ffe000104a464946000101", "hex");
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
// ftyp box whose brands are all MP4/QuickTime, not HEIF.
const MP4_HEADER = Buffer.from("0000001c667479706d70343200000000" + "6d703432" + "69736f6d", "hex");

describe("HEIC mime detection", () => {
  it("matches the HEIC/HEIF image mime types incl. -sequence", () => {
    expect(isHeicMimeType("image/heic")).toBe(true);
    expect(isHeicMimeType("image/heif")).toBe(true);
    expect(isHeicMimeType("image/heic-sequence")).toBe(true);
    expect(isHeicMimeType("IMAGE/HEIF")).toBe(true);
  });

  it("rejects non-HEIC mimes and junk", () => {
    expect(isHeicMimeType("image/jpeg")).toBe(false);
    expect(isHeicMimeType("image/png")).toBe(false);
    expect(isHeicMimeType(undefined)).toBe(false);
    expect(isHeicMimeType("")).toBe(false);
  });
});

describe("HEIC extension detection", () => {
  it("matches .heic/.heif case-insensitively", () => {
    expect(hasHeicExtension("/a/b/photo.heic")).toBe(true);
    expect(hasHeicExtension("/a/b/PHOTO.HEIF")).toBe(true);
    expect(hasHeicExtension("photo.jpg")).toBe(false);
    expect(hasHeicExtension("photo.heic.jpg")).toBe(false);
  });
});

describe("HEIC magic-byte sniffing", () => {
  it("detects a HEIF ftyp box by major or compatible brand", () => {
    expect(sniffHeic(HEIC_HEADER)).toBe(true);
  });

  it("does not misfire on JPEG, PNG, or MP4 headers", () => {
    expect(sniffHeic(JPEG_HEADER)).toBe(false);
    expect(sniffHeic(PNG_HEADER)).toBe(false);
    expect(sniffHeic(MP4_HEADER)).toBe(false);
    expect(sniffHeic(Buffer.alloc(4))).toBe(false);
  });
});

describe("looksLikeHeic (any signal)", () => {
  it("is true when any of mime / extension / magic bytes indicates HEIC", () => {
    expect(looksLikeHeic("image/heic", "x.jpg", JPEG_HEADER)).toBe(true); // mime
    expect(looksLikeHeic("image/jpeg", "x.heic", JPEG_HEADER)).toBe(true); // extension
    expect(looksLikeHeic("image/jpeg", "x.jpg", HEIC_HEADER)).toBe(true); // magic
    expect(looksLikeHeic("image/jpeg", "x.jpg", JPEG_HEADER)).toBe(false); // none
  });
});
