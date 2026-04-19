import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImagePath, mimeToExt, saveInboundImage } from "../src/channels/imageStore.js";

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
