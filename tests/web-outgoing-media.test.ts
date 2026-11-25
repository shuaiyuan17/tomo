import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTGOING_BYTES, MAX_OUTGOING_FILE_BYTES, OUTGOING_FILE_TYPE, OutgoingMediaError, OutgoingMediaStore } from "../src/web/outgoing-media.js";
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
  it("refuses private paths (as written and through a symlink), oversized files, and paths that are not there", () => {
    const secret = write("memory/private/diary.png", PNG);
    expect(() => store.file("dm:owner", ["r"], secret)).toThrow(OutgoingMediaError);
    const link = join(root, "innocent.png");
    symlinkSync(secret, link);
    expect(() => store.file("dm:owner", ["r"], link)).toThrow(expect.objectContaining({ code: "private" }));
    const notes = write("memory/private/notes.md", "secret");
    expect(() => store.file("dm:owner", ["r"], notes)).toThrow(expect.objectContaining({ code: "private" }));
    expect(() => store.file("dm:owner", ["r"], write("big.bin", Buffer.alloc(MAX_OUTGOING_FILE_BYTES + 1)))).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() => store.file("dm:owner", ["r"], join(root, "nope.png"))).toThrow(expect.objectContaining({ code: "missing" }));
    expect(() => store.file("dm:owner", ["r"], "relative.png")).toThrow(OutgoingMediaError);
    expect(() => store.file("dm:owner", ["r"], root)).toThrow(expect.objectContaining({ code: "missing" }));
    // Nothing was filed.
    expect(existsSync(join(root, "store"))).toBe(false);
  });
  it("files any other file (a .md, an SVG or HTML named .png) as a download: its sanitised name and size, never shown as a picture", () => {
    const md = write("pr636 review.md", "# Review\n\nP2: …\n");
    const filed = store.file("dm:owner", ["req-1"], md);
    expect(filed).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), type: OUTGOING_FILE_TYPE, name: "pr636_review.md", size: Buffer.byteLength("# Review\n\nP2: …\n") });
    expect(store.rewrite("dm:owner", ["req-1"], `The review:\nMEDIA:"${md}"`).content).toBe(`The review:\nMEDIA:web:file:${filed.id}:${filed.size}:pr636_review.md`);
    const read = store.read("dm:owner", filed.id)!;
    expect(read).toMatchObject({ type: OUTGOING_FILE_TYPE, name: "pr636_review.md" });
    expect(read.bytes.toString()).toBe("# Review\n\nP2: …\n");
    // Bytes that only claim to be a picture are a file, whatever the name says.
    for (const fake of [write("x.png", "<svg xmlns='http://www.w3.org/2000/svg'/>"), write("x.jpg", "<html><script>1</script></html>")]) {
      expect(store.file("dm:owner", ["r"], fake).type).toBe(OUTGOING_FILE_TYPE);
    }
    // A picture too big to show inline is still offered, as a download.
    expect(store.file("dm:owner", ["r"], write("huge.png", Buffer.concat([PNG, Buffer.alloc(MAX_OUTGOING_BYTES)])))).toMatchObject({ type: OUTGOING_FILE_TYPE, name: "huge.png" });
    // A file swapped for other bytes of another length is refused on read.
    const name = readdirSync(join(root, "store")).find((entry) => entry.startsWith(filed.id))!;
    writeFileSync(join(root, "store", name), "tampered, longer than before");
    expect(store.read("dm:owner", filed.id)).toBeUndefined();
  });
  it("a delivery on another channel is found again through the record's mediaRef, not through an unrelated turn", () => {
    const path = write("shot.png", PNG);
    const { id } = store.file("dm:owner", ["ref-1"], path);
    expect(store.rewrite("dm:owner", [undefined, undefined, "ref-1"], `MEDIA:${path}`).content).toBe(`MEDIA:web:${id}`);
    expect(store.rewrite("dm:owner", [undefined, undefined, "ref-2"], `MEDIA:${path}`).content).toBe("MEDIA:web:gone");
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
  it("a non-image MEDIA file (a .md) is no longer refused: the block carries it as a file card, by id, never its path", async () => {
    const { channel, events } = setup(store);
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "send me the review" });
    const md = write("tmp/pr636-review.md", "# Review\n");
    await channel.send({ chatId: requestId, text: "here", photo: md });
    const block = events.find((e): e is Extract<WebEvent, { type: "block" }> => e.type === "block")!;
    expect(block.images).toBeUndefined();
    expect(block.files).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{32}$/), name: "pr636-review.md", size: 9 }]);
    expect(JSON.stringify(block)).not.toContain(root);
    expect(store.read("dm:owner", block.files![0].id)?.bytes.toString()).toBe("# Review\n");
    await channel.stop();
  });
  it("mirrorMedia files another channel's delivery for the owner's DM only, under its ref; private paths are still refused", async () => {
    const { channel } = setup(store);
    const shot = write("tmp/after.png", PNG);
    channel.mirrorMedia("dm:owner", "ref-1", shot);
    expect(store.rewrite("dm:owner", [undefined, undefined, "ref-1"], `MEDIA:${shot}`).content).toMatch(/^MEDIA:web:[a-f0-9]{32}$/);
    channel.mirrorMedia("telegram:-1", "ref-2", shot);
    expect(store.rewrite("telegram:-1", ["ref-2"], `MEDIA:${shot}`).content).toBe("MEDIA:web:gone");
    const secret = write("memory/private/p.png", PNG);
    expect(() => channel.mirrorMedia("dm:owner", "ref-3", secret)).not.toThrow();
    expect(store.rewrite("dm:owner", ["ref-3"], `MEDIA:${secret}`).content).toBe("MEDIA:web:gone");
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
  it("MEDIA:web:file tokens become a row of file cards (name and size); pictures and files keep their own rows", () => {
    const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
    expect(splitMessage(`The review:\nMEDIA:web:file:${a}:1234:pr636-review.md\nMEDIA:web:file:${b}:9:notes.txt\nMEDIA:web:${c}\ndone`)).toEqual([
      { kind: "text", text: "The review:" },
      { kind: "sentFiles", files: [{ id: a, size: 1234, name: "pr636-review.md" }, { id: b, size: 9, name: "notes.txt" }] },
      { kind: "sent", ids: [c] }, { kind: "text", text: "done" }]);
    // A name outside the sanitised alphabet is not a token: it stays text.
    expect(splitMessage(`MEDIA:web:file:${a}:1:<b>.md`)[0]).toMatchObject({ kind: "text" });
  });
});
