import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { log } from "../src/logger.js";
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
      { filename: "~/Library/Messages/Attachments/x/IMG_1.heic", transfer_name: "IMG_1.heic", mime_type: "image/heic", transfer_state: 5 },
      { filename: null, transfer_name: "IMG_2.heic", mime_type: "image/heic", transfer_state: 0 },
    ]);
    const lookup = new ChatDbAttachmentLookup("/db/chat.db", () => sqlite.module);
    expect(lookup.attachmentsForMessage("msg-guid")).toEqual([
      { path: join(homedir(), "Library/Messages/Attachments/x/IMG_1.heic"), transferName: "IMG_1.heic", mimeType: "image/heic", transferState: 5 },
      { path: "", transferName: "IMG_2.heic", mimeType: "image/heic", transferState: 0 },
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

  it("retries opening after a transient busy/locked error", () => {
    const sqlite = fakeSqlite([{ filename: "/abs/a.png", transfer_name: "a.png", mime_type: "image/png", transfer_state: 5 }]);
    let attempts = 0;
    const lookup = new ChatDbAttachmentLookup("/db/chat.db", () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      return sqlite.module;
    });
    expect(lookup.attachmentsForMessage("g")).toEqual([]);
    expect(lookup.attachmentsForMessage("g")).toEqual([
      { path: "/abs/a.png", transferName: "a.png", mimeType: "image/png", transferState: 5 },
    ]);
    expect(attempts).toBe(2);
  });

  it("gives up for good (logged once) on a non-transient open error", () => {
    const warnSpy = vi.spyOn(log, "warn");
    let attempts = 0;
    const lookup = new ChatDbAttachmentLookup("/db/chat.db", () => {
      attempts++;
      throw Object.assign(new Error("unable to open database file"), { code: "ERR_SQLITE_ERROR", errcode: 14 });
    });
    expect(lookup.attachmentsForMessage("g")).toEqual([]);
    expect(lookup.attachmentsForMessage("g")).toEqual([]);
    expect(attempts).toBe(1);
    expect(warnSpy.mock.calls.filter(([, m]) => typeof m === "string" && m.includes("attachment lookup unavailable"))).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("never reopens chat.db once closed", () => {
    const sqlite = fakeSqlite([]);
    const lookup = new ChatDbAttachmentLookup("/db/chat.db", () => sqlite.module);
    lookup.attachmentsForMessage("g");
    lookup.close();
    expect(lookup.attachmentsForMessage("g")).toEqual([]);
    expect(sqlite.DatabaseSync).toHaveBeenCalledTimes(1);
    expect(sqlite.all).toHaveBeenCalledTimes(1);
  });
});
