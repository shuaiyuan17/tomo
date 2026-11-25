import { describe, expect, it } from "vitest";
import { extractAttachments, extractMedia, isSilentReply } from "../src/agent/text-utils.js";

// The whole-reply silence check and the MEDIA:/STICKER: tag extraction from
// src/agent/text-utils.ts. The trailing-line NO_REPLY rule per block is in
// tests/text-utils.test.ts.

describe("isSilentReply", () => {
  it("detects NO_REPLY", () => {
    expect(isSilentReply("NO_REPLY")).toBe(true);
  });

  it("detects with whitespace", () => {
    expect(isSilentReply("  NO_REPLY  ")).toBe(true);
    expect(isSilentReply("\nNO_REPLY\n")).toBe(true);
  });

  it("case insensitive", () => {
    expect(isSilentReply("no_reply")).toBe(true);
    expect(isSilentReply("No_Reply")).toBe(true);
  });

  it("rejects messages with content", () => {
    expect(isSilentReply("Here is a response. NO_REPLY")).toBe(false);
    expect(isSilentReply("NO_REPLY but also this")).toBe(false);
    expect(isSilentReply("hello")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSilentReply("")).toBe(false);
  });
});

describe("extractMedia", () => {
  it("extracts single media path", () => {
    const { cleanText, mediaPaths } = extractMedia('Here is the image MEDIA: "/tmp/photo.png"');
    expect(mediaPaths).toEqual(["/tmp/photo.png"]);
    expect(cleanText).toBe("Here is the image");
  });

  it("extracts multiple media paths", () => {
    const { cleanText, mediaPaths } = extractMedia(
      'First image MEDIA: "/tmp/a.png"\nSecond image MEDIA: "/tmp/b.jpg"',
    );
    expect(mediaPaths).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
    expect(cleanText).toMatch(/First image\s*\nSecond image/);
  });

  it("handles unquoted paths", () => {
    const { mediaPaths } = extractMedia("MEDIA: /tmp/photo.png");
    expect(mediaPaths).toEqual(["/tmp/photo.png"]);
  });

  it("handles quoted paths with spaces", () => {
    const { cleanText, mediaPaths } = extractMedia('Here is the image MEDIA:"/tmp/my photo.png"');
    expect(mediaPaths).toEqual(["/tmp/my photo.png"]);
    expect(cleanText).toBe("Here is the image");
  });

  it("returns empty array when no media", () => {
    const { cleanText, mediaPaths } = extractMedia("Just a normal message");
    expect(mediaPaths).toEqual([]);
    expect(cleanText).toBe("Just a normal message");
  });

  it("handles empty string", () => {
    const { cleanText, mediaPaths } = extractMedia("");
    expect(mediaPaths).toEqual([]);
    expect(cleanText).toBe("");
  });

  it("case insensitive matching", () => {
    const { mediaPaths } = extractMedia('media: "/tmp/test.png"');
    expect(mediaPaths).toEqual(["/tmp/test.png"]);
  });
});

describe("extractAttachments", () => {
  it("extracts sticker file ids and strips tags from text", () => {
    const { cleanText, mediaPaths, stickerIds } = extractAttachments("here STICKER:CAACAgQAAxkBAAE123 ok");
    expect(cleanText).toBe("here  ok");
    expect(mediaPaths).toEqual([]);
    expect(stickerIds).toEqual(["CAACAgQAAxkBAAE123"]);
  });

  it("extracts media and sticker tags together", () => {
    const { cleanText, mediaPaths, stickerIds } = extractAttachments('Look MEDIA:"/tmp/a.png" STICKER:"CAAC-123"');
    expect(cleanText).toBe("Look");
    expect(mediaPaths).toEqual(["/tmp/a.png"]);
    expect(stickerIds).toEqual(["CAAC-123"]);
  });
});
