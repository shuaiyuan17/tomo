import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChatDbAttachmentLookup, expandChatDbPath } from "../src/channels/imsg-attachment-lookup.js";

describe("expandChatDbPath", () => {
  it("expands chat.db's ~/ form and leaves absolute paths alone", () => {
    expect(expandChatDbPath("~/Library/Messages/Attachments/a/b.heic")).toBe(join(homedir(), "Library/Messages/Attachments/a/b.heic"));
    expect(expandChatDbPath("/abs/b.heic")).toBe("/abs/b.heic");
  });
});

describe("ChatDbAttachmentLookup", () => {
  const fakeSqlite = (rows: Array<Record<string, unknown>> | Error) => {
    const all = vi.fn(() => {
      if (rows instanceof Error) throw rows;
      return rows;
    });
    const prepare = vi.fn(() => ({ all }));
    const close = vi.fn();
    const DatabaseSync = vi.fn(function (this: unknown) {
      return { prepare, close };
    });
    return { module: { DatabaseSync } as never, all, prepare, close, DatabaseSync };
  };

  it("opens chat.db read-only and maps a message's attachment rows", () => {
    const sqlite = fakeSqlite([
      { filename: "~/Library/Messages/Attachments/x/IMG_1.heic", transfer_name: "IMG_1.heic", mime_type: "image/heic" },
      { filename: null, transfer_name: "IMG_2.heic", mime_type: "image/heic" },
    ]);
    const lookup = new ChatDbAttachmentLookup("/db/chat.db", () => sqlite.module);
    expect(lookup.attachmentsForMessage("msg-guid")).toEqual([
      { path: join(homedir(), "Library/Messages/Attachments/x/IMG_1.heic"), transferName: "IMG_1.heic", mimeType: "image/heic" },
      { path: "", transferName: "IMG_2.heic", mimeType: "image/heic" },
    ]);
    expect(sqlite.DatabaseSync).toHaveBeenCalledWith("/db/chat.db", { readOnly: true });
    expect(sqlite.all).toHaveBeenCalledWith("msg-guid");
    lookup.close();
    expect(sqlite.close).toHaveBeenCalled();
  });

  it("degrades to no rows when chat.db cannot be opened or queried", () => {
    const unopenable = new ChatDbAttachmentLookup("/db/chat.db", () => { throw new Error("no FDA"); });
    expect(unopenable.attachmentsForMessage("g")).toEqual([]);
    const broken = new ChatDbAttachmentLookup("/db/chat.db", () => fakeSqlite(new Error("schema drift")).module);
    expect(broken.attachmentsForMessage("g")).toEqual([]);
    expect(broken.attachmentsForMessage("")).toEqual([]);
  });
});
