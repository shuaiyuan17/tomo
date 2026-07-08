import { EventEmitter } from "node:events";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";
import { isHeicMimeType, hasHeicExtension, sniffHeic, looksLikeHeic, convertHeicToJpeg } from "../src/channels/heic.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

/** Minimal stand-in for a spawned `sips` child. */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
}

/** Pull the `--out <path>` value the code chose out of the spawn args. */
function outPathFromArgs(args: string[]): string {
  const idx = args.indexOf("--out");
  return idx >= 0 ? args[idx + 1] : "";
}

afterEach(() => {
  spawnMock.mockReset();
});

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

describe("convertHeicToJpeg temp-file cleanup", () => {
  it("unlinks the partial temp output on non-zero sips exit and returns null (no leak)", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      // sips wrote a partial/corrupt file before failing.
      writeFileSync(capturedOut, Buffer.from("partial"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });

    const result = await convertHeicToJpeg("/tmp/input.heic");

    expect(result).toBeNull();
    expect(capturedOut).not.toBe("");
    expect(existsSync(capturedOut)).toBe(false);
  });

  it("unlinks the temp output on a spawn error and returns null", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("partial"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn sips ENOENT")));
      return child;
    });

    const result = await convertHeicToJpeg("/tmp/input.heic");

    expect(result).toBeNull();
    expect(existsSync(capturedOut)).toBe(false);
  });

  it("returns null without throwing when no temp file was written (ENOENT tolerated)", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      const child = new FakeChild(); // never wrote outPath
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    });

    const result = await convertHeicToJpeg("/tmp/input.heic");

    expect(result).toBeNull();
    expect(existsSync(capturedOut)).toBe(false);
  });

  it("returns the output path on a successful (code 0) conversion", async () => {
    let capturedOut = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      capturedOut = outPathFromArgs(args);
      writeFileSync(capturedOut, Buffer.from("ffd8ffe0", "hex"));
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });

    const result = await convertHeicToJpeg("/tmp/input.heic");

    expect(result).toBe(capturedOut);
    expect(existsSync(capturedOut)).toBe(true);
    unlinkSync(capturedOut);
  });
});
