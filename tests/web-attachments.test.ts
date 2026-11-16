import { describe, expect, it } from "vitest";
import { splitAttachments } from "../web/src/attachments.js";

const IMG = "/Users/x/.tomo/workspace/memory/incoming-images/2026-11-14/123533_imessage_any_-__abc12345.png";

describe("attachment markers", () => {
  it("an image marker becomes an image part; the text around it stays", () => {
    expect(splitAttachments(`[Sent an image, saved to: ${IMG}] looks like a long path`)).toEqual([
      { kind: "images", paths: [IMG], sticker: false, missing: 0, more: 0 },
      { kind: "text", text: "looks like a long path" },
    ]);
  });
  it("several images, one still downloading", () => {
    const [part] = splitAttachments(`[Sent 2 images, saved to: /a/1.png; 1 still downloading — will follow in a separate message once received]`);
    expect(part).toEqual({ kind: "images", paths: ["/a/1.png"], sticker: false, missing: 1, more: 0 });
  });
  it("stickers, documents and files", () => {
    expect(splitAttachments(`[Sent a sticker, saved to: /s/x.png; resend with STICKER:<saved path>]`)[0]).toMatchObject({ kind: "images", sticker: true, paths: ["/s/x.png"] });
    expect(splitAttachments(`see [Sent a document, saved to: /d/2026/report.pdf]`)).toEqual([
      { kind: "text", text: "see " }, { kind: "attachment", label: "Document", names: ["report.pdf"] }]);
    expect(splitAttachments(`[Sent a file: notes.zip — saved to /f/notes.zip. Contents not attached to this message — open the path if you need them.]`)[0])
      .toMatchObject({ kind: "attachment", label: "File", names: ["notes.zip"] });
  });
  it("plain text is untouched (including line breaks)", () => {
    expect(splitAttachments("• one\n• two")).toEqual([{ kind: "text", text: "• one\n• two" }]);
    expect(splitAttachments("[Sent nothing]")).toEqual([{ kind: "text", text: "[Sent nothing]" }]);
  });
  it("shows at most 20 thumbnails per message and counts the rest", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `/p/${i}.png`);
    const [part] = splitAttachments(`[Sent 30 images, saved to: ${paths.join(", ")}]`);
    expect(part).toMatchObject({ kind: "images", more: 10 });
    expect((part as { paths: string[] }).paths).toHaveLength(20);
    expect((part as { missing: number }).missing).toBe(0);
  });
});
