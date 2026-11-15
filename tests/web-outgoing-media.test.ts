import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTGOING_BYTES, OutgoingMediaError, OutgoingMediaStore } from "../src/web/outgoing-media.js";
import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import type { WebEvent } from "../src/web/protocol.js";
import { splitMessage } from "../web/src/attachments.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let root: string;
let store: OutgoingMediaStore;
const isPrivate = (path: string) => path.includes("/memory/private/");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-outgoing-"));
  store = new OutgoingMediaStore(join(root, "store"), { isPrivate });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (name: string, bytes: Buffer | string) => { const path = join(root, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes); return path; };

describe("OutgoingMediaStore", () => {
  it("copies an image at delivery, so it survives its source; history swaps the tag for its id", () => {
    const path = write("gap.png", PNG);
    const { id, type } = store.file("dm:owner", ["req-1", "turn-1"], path);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(type).toBe("image/png");
    unlinkSync(path);
    expect(store.read("dm:owner", id)?.bytes.equals(PNG)).toBe(true);
    const { content } = store.rewrite("dm:owner", ["req-1"], `Here:\nMEDIA:${path}\nand STICKER:"${path}"`);
    expect(content).toBe(`Here:\nMEDIA:web:${id}\nand MEDIA:web:${id}`);
    expect(content).not.toContain(path);
  });
  it("an older message (or another turn's tag, or a file_id sticker) becomes `gone`, never the path", () => {
    const path = write("a.png", PNG);
    store.file("dm:owner", ["req-1"], path);
    expect(store.rewrite("dm:owner", ["req-2"], `MEDIA:${path}`).content).toBe("MEDIA:web:gone");
    expect(store.rewrite("dm:owner", [undefined], "MEDIA:/tmp/old.jpg").content).toBe("MEDIA:web:gone");
    expect(store.rewrite("dm:owner", ["req-1"], "STICKER:CAACAgIAAxkBAAE").content).toBe("MEDIA:web:gone");
    expect(store.rewrite("telegram:-1", ["req-1"], `MEDIA:${path}`).content).toBe("MEDIA:web:gone");
  });
  it("refuses private paths (as written and through a symlink), non-images (svg/html), and oversized files", () => {
    const secret = write("memory/private/diary.png", PNG);
    expect(() => store.file("dm:owner", ["r"], secret)).toThrow(OutgoingMediaError);
    const link = join(root, "innocent.png");
    symlinkSync(secret, link);
    expect(() => store.file("dm:owner", ["r"], link)).toThrow(expect.objectContaining({ code: "private" }));
    expect(() => store.file("dm:owner", ["r"], write("x.png", "<svg xmlns='http://www.w3.org/2000/svg'/>"))).toThrow(expect.objectContaining({ code: "not_image" }));
    expect(() => store.file("dm:owner", ["r"], write("x.jpg", "<html><script>1</script></html>"))).toThrow(expect.objectContaining({ code: "not_image" }));
    expect(() => store.file("dm:owner", ["r"], write("big.png", Buffer.concat([PNG, Buffer.alloc(MAX_OUTGOING_BYTES)])))).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() => store.file("dm:owner", ["r"], join(root, "nope.png"))).toThrow(expect.objectContaining({ code: "missing" }));
    expect(() => store.file("dm:owner", ["r"], "relative.png")).toThrow(OutgoingMediaError);
    // Nothing was filed.
    expect(existsSync(join(root, "store"))).toBe(false);
  });
  it("an id cannot be guessed or bent into reading another file or another session's picture", () => {
    const { id } = store.file("dm:owner", ["r"], write("a.png", PNG));
    expect(store.read("telegram:-1", id)).toBeUndefined();
    expect(store.read("dm:owner", "0".repeat(32))).toBeUndefined();
    for (const bad of ["../index", `${id}/../x`, id.toUpperCase(), `${id}.png`, ""]) expect(store.read("dm:owner", bad)).toBeUndefined();
    // A filed name swapped for a link out of the store is refused.
    const file = readdirSync(join(root, "store")).find((name) => name.startsWith(id))!;
    unlinkSync(join(root, "store", file));
    symlinkSync(write("other.png", PNG), join(root, "store", file));
    expect(store.read("dm:owner", id)).toBeUndefined();
  });
});

describe("the web outlet files pictures instead of failing the request", () => {
  const setup = (outgoingMedia?: OutgoingMediaStore) => {
    const channel = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(), { outgoingMedia });
    channel.onMessage(vi.fn(async () => true));
    const events: WebEvent[] = [];
    channel.events.subscribe(({ event }) => events.push(event));
    return { channel, events };
  };
  it("a MEDIA picture becomes a block with its id; a refused one fails only that piece", async () => {
    const { channel, events } = setup(store);
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "show me" });
    await channel.send({ chatId: requestId, text: "the gap", photo: write("gap.png", PNG) });
    const block = events.find((e): e is Extract<WebEvent, { type: "block" }> => e.type === "block")!;
    expect(block.text).toBe("the gap");
    expect(block.images).toHaveLength(1);
    expect(JSON.stringify(block)).not.toContain("gap.png");
    await expect(channel.send({ chatId: requestId, text: "", photo: write("memory/private/p.png", PNG) })).rejects.toThrow(/refused: private/);
    expect(channel.request(requestId).state).not.toBe("failed");
    await channel.stop();
  });
});

describe("splitMessage (browser)", () => {
  it("MEDIA:web tokens become thumbnail rows between the text; gone ones are placeholders", () => {
    const id = "a".repeat(32);
    expect(splitMessage(`Look:\nMEDIA:web:${id}\nMEDIA:web:gone\nnice`)).toEqual([
      { kind: "text", text: "Look:" }, { kind: "sent", ids: [id, null] }, { kind: "text", text: "nice" }]);
    expect(splitMessage("plain text")).toEqual([{ kind: "text", text: "plain text" }]);
    expect(splitMessage("MEDIA:/tmp/raw-path.png")).toEqual([{ kind: "text", text: "MEDIA:/tmp/raw-path.png" }]);
  });
});
