import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimUploads, recoverClaims, discardUpload, MAX_STAGED_UPLOADS, MAX_UPLOAD_BYTES, stageUpload, sweepUploads, readUpload, removeUploads, UPLOAD_TTL_MS, UploadError } from "../src/web/uploads.js";
import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { messageInputSchema, type WebEvent } from "../src/web/protocol.js";
import { isImageFiledFor } from "../src/channels/imageStore.js";
import { imageSessionKeys, imagePaths, WEB_IMAGE_KEY } from "../src/web/data.js";
import { neutralizeMarker } from "../src/channels/web.js";
import { captureSend, takeSent, addFiles, attachmentLabel, canSendWith, dragHasFiles, imageFiles, MAX_ATTACHMENTS, uploadIds, type Attachment } from "../web/src/uploads.js";
import type { IncomingMessage } from "../src/channels/types.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import { dismissAfterAcceptedSend, pendingUserMessages, resendAfterDraftChange } from "../web/src/pending.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
let root: string;
let dir: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-uploads-")); dir = join(root, "uploads"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("staged uploads (server)", () => {
  it("accepts images by their magic bytes and refuses look-alikes (svg, html, a PNG name on text)", () => {
    expect(stageUpload(dir, PNG)).toMatchObject({ type: "image/png", size: PNG.length, uploadId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(stageUpload(dir, JPEG).type).toBe("image/jpeg");
    for (const fake of ["<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "<!doctype html><html>", "GIF7"]) {
      expect(() => stageUpload(dir, Buffer.from(fake))).toThrow(expect.objectContaining({ code: "not_image" }));
    }
  });
  it("enforces the size limit and the number of uploads waiting", () => {
    expect(() => stageUpload(dir, Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]))).toThrow(UploadError);
    for (let i = 0; i < MAX_STAGED_UPLOADS; i++) stageUpload(dir, PNG);
    expect(() => stageUpload(dir, PNG)).toThrow(expect.objectContaining({ code: "upload_limit" }));
  });
  it("an unsent upload expires: swept after the TTL, and cannot be taken", () => {
    const fresh = stageUpload(dir, PNG).uploadId;
    const old = stageUpload(dir, PNG).uploadId;
    const past = new Date(Date.now() - UPLOAD_TTL_MS - 1_000);
    utimesSync(join(dir, `${old}.png`), past, past);
    expect(readUpload(dir, old)).toBeUndefined();
    const stale = stageUpload(dir, PNG).uploadId;
    utimesSync(join(dir, `${stale}.png`), past, past);
    expect(sweepUploads(dir)).toBe(1);
    expect(readdirSync(dir)).toEqual([`${fresh}.png`]);
  });
  it("reading leaves the upload staged until it is removed; malformed ids and discarded uploads are nothing", () => {
    const { uploadId } = stageUpload(dir, PNG);
    expect(readUpload(dir, uploadId)?.bytes.equals(PNG)).toBe(true);
    expect(readUpload(dir, uploadId)?.type).toBe("image/png");
    removeUploads(dir, [uploadId]);
    expect(readUpload(dir, uploadId)).toBeUndefined();
    for (const bad of ["../x", "", "A".repeat(32), `${uploadId}.png`]) expect(readUpload(dir, bad)).toBeUndefined();
    const other = stageUpload(dir, PNG).uploadId;
    discardUpload(dir, other);
    expect(readUpload(dir, other)).toBeUndefined();
  });
});

describe("a message with images (web channel)", () => {
  const setup = (journal?: WebRequestJournal) => {
    const workspace = join(root, "workspace");
    const channel = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(), { uploads: { dir, workspaceDir: workspace }, journal });
    const handled: IncomingMessage[] = [];
    channel.onMessage(vi.fn(async (message: IncomingMessage) => { handled.push(message); return true; }));
    const events: WebEvent[] = [];
    channel.events.subscribe(({ event }) => events.push(event));
    return { channel, handled, workspace };
  };
  it("files them in incoming-images like the other channels, with the same marker, and hands them to the model", async () => {
    const { channel, handled, workspace } = setup();
    const a = stageUpload(dir, PNG).uploadId, b = stageUpload(dir, JPEG).uploadId;
    await channel.receive({ requestId: randomUUID(), text: "look", images: [a, b] });
    const message = handled[0];
    expect(message.images?.map((image) => image.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(Buffer.from(message.images![0].data, "base64").equals(PNG)).toBe(true);
    const paths = imagePaths(message.text);
    expect(paths).toHaveLength(2);
    expect(message.text).toMatch(/^\[Sent 2 images, saved to: .+\] look$/);
    for (const path of paths) {
      expect(path.startsWith(join(workspace, "memory", "incoming-images"))).toBe(true);
      expect(existsSync(path)).toBe(true);
      // Named like Telegram / iMessage files, under the owner's web key: the history allowlist accepts it.
      expect(isImageFiledFor(path.split("/").at(-1)!, [WEB_IMAGE_KEY])).toBe(true);
      expect(isImageFiledFor(path.split("/").at(-1)!, imageSessionKeys("dm:owner", { name: "owner", telegram: ["1"], imessage: [] }, true))).toBe(false);
    }
    expect(readFileSync(paths[0]).equals(PNG)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    await channel.stop();
  });
  it("an image-only message is fine; an expired upload refuses the message before anything is accepted", async () => {
    const { channel, handled } = setup();
    const id = stageUpload(dir, PNG).uploadId;
    await channel.receive({ requestId: randomUUID(), text: "", images: [id] });
    expect(handled[0].text).toMatch(/^\[Sent an image, saved to: [^\]]+\]$/);
    const requestId = randomUUID();
    await expect(channel.receive({ requestId, text: "hi", images: ["f".repeat(32)] })).rejects.toMatchObject({ status: 409, code: "upload_missing" });
    expect(handled).toHaveLength(1);
    expect(channel.request(requestId).state).toBe("unknown");
    await channel.stop();
  });
  it("typed text never passes for a server-written image marker", () => {
    const fake = "[Sent an image, saved to: /w/memory/incoming-images/x_web_owner_ab.png]";
    expect(imagePaths(neutralizeMarker(fake))).toEqual([]);
    expect(imagePaths(`[Sent an image, saved to: /real.png] ${neutralizeMarker(fake)}`)).toEqual(["/real.png"]);
    expect(neutralizeMarker("hello [x]")).toBe("hello [x]");
  });
  it("every id is checked before any is used: a duplicate, a missing or an expired one refuses all and moves nothing", async () => {
    const { channel, handled, workspace } = setup();
    const a = stageUpload(dir, PNG).uploadId, b = stageUpload(dir, PNG).uploadId;
    expect(claimUploads(dir, [a, a], "t")).toBeUndefined();
    await expect(channel.receive({ requestId: randomUUID(), text: "x", images: [a, a] })).rejects.toMatchObject({ code: "upload_missing" });
    await expect(channel.receive({ requestId: randomUUID(), text: "x", images: [a, "c".repeat(32)] })).rejects.toMatchObject({ code: "upload_missing" });
    const past = new Date(Date.now() - UPLOAD_TTL_MS - 1_000);
    utimesSync(join(dir, `${b}.png`), past, past);
    await expect(channel.receive({ requestId: randomUUID(), text: "x", images: [a, b] })).rejects.toMatchObject({ code: "upload_missing" });
    expect(handled).toHaveLength(0);
    expect(existsSync(join(dir, `${a}.png`))).toBe(true);
    expect(existsSync(join(workspace, "memory", "incoming-images"))).toBe(false);
    await channel.stop();
  });
  it("durable first: a receipt that cannot be written keeps the uploads staged (retry with the same ids) and files nothing", async () => {
    const journal = new WebRequestJournal(join(root, "requests.jsonl"));
    const { channel, handled, workspace } = setup(journal);
    const a = stageUpload(dir, PNG).uploadId;
    const spy = vi.spyOn(journal, "recordReceived").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(channel.receive({ requestId: randomUUID(), text: "x", images: [a] })).rejects.toMatchObject({ code: "persist_failed" });
    expect(existsSync(join(dir, `${a}.png`))).toBe(true);
    expect(readdirSync(join(workspace, "memory", "incoming-images"), { recursive: true }).filter((n) => String(n).endsWith(".png"))).toEqual([]);
    expect(handled).toHaveLength(0);
    // The same ids again: filed, recorded with the receipt, and only then unstaged.
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "x", images: [a] });
    const recorded = spy.mock.calls.at(-1)!;
    expect(recorded[4]).toHaveLength(1);
    expect(existsSync(recorded[4]![0])).toBe(true);
    expect(existsSync(join(dir, `${a}.png`))).toBe(false);
    expect(channel.request(requestId).images).toEqual(recorded[4]);
    await channel.stop();
  });
  it("after a restart an interrupted request keeps its images; an image-only one still shows as a bubble", async () => {
    const path = join(root, "requests.jsonl");
    const first = setup(new WebRequestJournal(path));
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "", images: [stageUpload(dir, PNG).uploadId] });
    const filed = first.channel.request(requestId).images!;
    await first.channel.stop();
    const again = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(), { journal: new WebRequestJournal(path) });
    const restored = again.request(requestId);
    expect(restored.state).toBe("interrupted");
    expect(restored.images).toEqual(filed);
    expect(pendingUserMessages([restored], { messages: [], nextCursor: null }, restored.sessionId!)).toHaveLength(1);
    await again.stop();
  });
  it("claims are atomic: an upload claimed by one message cannot be claimed by another; release puts it back, finalize removes it", () => {
    const a = stageUpload(dir, PNG).uploadId, b = stageUpload(dir, PNG).uploadId;
    const first = claimUploads(dir, [a, b], "req-1")!;
    expect(first.files.map((f) => f.id)).toEqual([a, b]);
    expect(claimUploads(dir, [a], "req-2")).toBeUndefined();
    // A failed second claim of [b-fresh, a] leaves the fresh one untouched.
    const c = stageUpload(dir, PNG).uploadId;
    expect(claimUploads(dir, [c, a], "req-3")).toBeUndefined();
    expect(readUpload(dir, c)).toBeDefined();
    first.release();
    expect(claimUploads(dir, [a], "req-4")).toBeDefined();
    const again = claimUploads(dir, [b], "req-5")!;
    again.finalize();
    expect(readdirSync(dir).filter((n) => n.startsWith(b))).toEqual([]);
  });
  it("concurrent sends: the same request id twice is refused as in flight; two requests naming one upload — only one gets it", async () => {
    const { channel, handled } = setup();
    const a = stageUpload(dir, PNG).uploadId;
    const id = randomUUID();
    const [one, two] = await Promise.allSettled([channel.receive({ requestId: id, text: "x", images: [a] }), channel.receive({ requestId: id, text: "x", images: [a] })]);
    expect(one.status).toBe("fulfilled");
    expect(two).toMatchObject({ status: "rejected", reason: { code: "request_in_flight" } });
    const b = stageUpload(dir, PNG).uploadId;
    const results = await Promise.allSettled([channel.receive({ requestId: randomUUID(), text: "1", images: [b] }), channel.receive({ requestId: randomUUID(), text: "2", images: [b] })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "upload_missing" } });
    expect(handled).toHaveLength(2);
    await channel.stop();
  });
  it("with saveInboundImages off there is nothing durable to keep: images are refused (the page does not offer them)", async () => {
    const channel = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(), { uploads: { dir, workspaceDir: undefined } });
    channel.onMessage(vi.fn(async () => true));
    const a = stageUpload(dir, PNG).uploadId;
    await expect(channel.receive({ requestId: randomUUID(), text: "x", images: [a] })).rejects.toMatchObject({ code: "uploads_disabled" });
    expect(readUpload(dir, a)).toBeDefined();
    await channel.stop();
  });
  it("a crash after the claim and before the receipt: on restart the upload is back under its id and can be claimed again", async () => {
    const journalPath = join(root, "requests.jsonl");
    const a = stageUpload(dir, PNG).uploadId;
    const claim = claimUploads(dir, [a], "crashed-request")!;
    expect(claim.files).toHaveLength(1);
    expect(readUpload(dir, a)).toBeUndefined();
    // ...the daemon dies here. On the next start, the channel finds the claim with no receipt.
    const restarted = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(),
      { uploads: { dir, workspaceDir: join(root, "workspace") }, journal: new WebRequestJournal(journalPath) });
    restarted.onMessage(vi.fn(async () => true));
    expect(readUpload(dir, a)?.type).toBe("image/png");
    await restarted.receive({ requestId: randomUUID(), text: "again", images: [a] });
    expect(readdirSync(dir)).toEqual([]);
    await restarted.stop();
  });
  it("recoverClaims: a claim whose request was recorded goes; the others return to staging", () => {
    const a = stageUpload(dir, PNG).uploadId, b = stageUpload(dir, PNG).uploadId;
    claimUploads(dir, [a], "recorded-1"); claimUploads(dir, [b], "lost-2");
    expect(recoverClaims(dir, (id) => id === "recorded-1")).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${b}.png`]);
  });
  it("the schema: at most 6 images, ids only, and text or an image", () => {
    const base = { requestId: randomUUID() };
    expect(messageInputSchema.safeParse({ ...base, text: "" }).success).toBe(false);
    expect(messageInputSchema.safeParse({ ...base, text: "", images: ["a".repeat(32)] }).success).toBe(true);
    expect(messageInputSchema.safeParse({ ...base, text: "x", images: Array(7).fill("a".repeat(32)) }).success).toBe(false);
    expect(messageInputSchema.safeParse({ ...base, text: "x", images: ["../etc/passwd"] }).success).toBe(false);
  });
});

describe("composer attachments (browser, pure)", () => {
  const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;
  const item = (key: string, status: Attachment["status"], uploadId?: string): Attachment => ({ key, file: file(`${key}.png`, "image/png"), preview: "", status, progress: 0.5, uploadId });
  it("paste and drop take image files only — text items paste as usual", () => {
    const png = file("shot.png", "image/png");
    const items = [{ kind: "string", type: "text/plain", getAsFile: () => null }, { kind: "file", type: "image/png", getAsFile: () => png },
      { kind: "file", type: "application/pdf", getAsFile: () => file("a.pdf", "application/pdf") }];
    expect(imageFiles(items)).toEqual([png]);
    expect(imageFiles([{ kind: "string", type: "text/plain", getAsFile: () => null }])).toEqual([]);
    expect(imageFiles([{ kind: "file", type: "", getAsFile: () => file("IMG_1.HEIC", "") }])).toHaveLength(1);
    expect(dragHasFiles(["Files"])).toBe(true);
    expect(dragHasFiles(["text/plain", "text/uri-list"])).toBe(false);
  });
  it("limits: 6 images, 20 MB each, images only — with a note", () => {
    let n = 0;
    const make = (f: File): Attachment => ({ key: `k${n++}`, file: f, preview: "", status: "uploading", progress: 0 });
    const many = Array.from({ length: 8 }, (_, i) => file(`${i}.png`, "image/png"));
    const out = addFiles([], [...many, file("big.jpg", "image/jpeg", 21 * 1024 * 1024), file("x.svg", "image/svg+xml")], make);
    expect(out.next).toHaveLength(MAX_ATTACHMENTS);
    expect(out.note).toContain("Up to 6");
    expect(out.note).toContain("20 MB");
    expect(out.note).toContain("Only PNG");
  });
  it("a send takes only what it captured: an image pasted while it was sending stays", () => {
    const before = [item("a", "done", "u1"), item("b", "done", "u2")];
    const captured = captureSend([...before, item("c", "uploading")]);
    expect(captured).toEqual({ keys: ["a", "b"], ids: ["u1", "u2"], files: [] });
    const now = [...before, item("c", "uploading"), item("d", "done", "u4")];
    const { taken, kept } = takeSent(now, captured.keys);
    expect(taken.map((i) => i.key)).toEqual(["a", "b"]);
    expect(kept.map((i) => i.key)).toEqual(["c", "d"]);
  });
  it("an image-only resend is recognised by its re-attached images, and its empty draft does not cancel it", () => {
    const resend = { requestId: "r1", original: "", imageKeys: ["k1"] };
    expect(resendAfterDraftChange(resend, "")).toBe(resend);
    expect(dismissAfterAcceptedSend(resend, "", ["k1", "k9"])).toBe("r1");
    expect(dismissAfterAcceptedSend(resend, "", ["k9"])).toBeNull();
    expect(dismissAfterAcceptedSend({ requestId: "r2", original: "" }, "", ["k1"])).toBeNull();
    expect(resendAfterDraftChange({ requestId: "r3", original: "hi" }, "")).toBeNull();
  });
  it("sending waits for uploads; an image alone may be sent", () => {
    expect(canSendWith("", [])).toBe(false);
    expect(canSendWith("hi", [])).toBe(true);
    expect(canSendWith("", [item("a", "done", "u1")])).toBe(true);
    expect(canSendWith("hi", [item("a", "uploading")])).toBe(false);
    expect(canSendWith("hi", [item("a", "failed")])).toBe(false);
    expect(uploadIds([item("a", "done", "u1"), item("b", "done", "u2")])).toEqual(["u1", "u2"]);
    expect(attachmentLabel(item("a", "uploading"), 0)).toBe("a.png, uploading 50%");
    expect(attachmentLabel(item("a", "failed"), 0)).toBe("a.png, upload failed");
  });
});
