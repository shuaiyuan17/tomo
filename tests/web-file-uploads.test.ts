import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage as HttpIncoming } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimUploads, MAX_UPLOAD_FILE_BYTES, stageUpload } from "../src/web/uploads.js";
import { WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { messageInputSchema, type WebBootstrap } from "../src/web/protocol.js";
import { buildFilePath, formatFileMarker, MAX_FILE_BYTES } from "../src/channels/fileStore.js";
import { WebRequestJournal } from "../src/web/request-journal.js";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { webSessionId } from "../src/web/owner.js";
import type { IncomingMessage } from "../src/channels/types.js";
import { splitAttachments } from "../web/src/attachments.js";
import { addFiles, captureSend, filedAttachment, formatSize, pastedFiles, replaceItems, type Attachment , noteText } from "../web/src/uploads.js";
import { applyRestored, dismissAfterAcceptedSend, missingAttachments, resendAfterDraftChange, resendAfterSend } from "../web/src/pending.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MD = Buffer.from("# Notes\n\n- one\n- two\n");
let root: string;
let dir: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tomo-file-uploads-")); dir = join(root, "uploads"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const setup = (journal?: WebRequestJournal) => {
  const workspace = join(root, "workspace");
  const channel = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(),
    { uploads: { dir, workspaceDir: workspace, fileDir: workspace }, journal });
  const handled: IncomingMessage[] = [];
  channel.onMessage(vi.fn(async (message: IncomingMessage) => { handled.push(message); return true; }));
  return { channel, handled, workspace };
};

describe("staging a non-image file", () => {
  it("is refused unless file uploads are on; then staged as a plain .bin, never executable", () => {
    expect(() => stageUpload(dir, MD)).toThrow(expect.objectContaining({ code: "not_image" }));
    const staged = stageUpload(dir, MD, Date.now(), true);
    expect(staged).toMatchObject({ kind: "file", size: MD.length });
    expect(readdirSync(dir)).toEqual([`${staged.uploadId}.bin`]);
    expect(statSync(join(dir, `${staged.uploadId}.bin`)).mode & 0o111).toBe(0);
    // An image is still an image.
    expect(stageUpload(dir, PNG, Date.now(), true)).toMatchObject({ kind: "image", type: "image/png" });
    // Images off, files on: a picture goes as a plain file.
    expect(stageUpload(dir, PNG, Date.now(), true, false)).toMatchObject({ kind: "file" });
  });
  it("the cap is the iMessage channel's inbound file cap; over it is refused as too_large", () => {
    expect(MAX_UPLOAD_FILE_BYTES).toBe(MAX_FILE_BYTES);
    expect(() => stageUpload(dir, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61), Date.now(), true)).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(stageUpload(dir, Buffer.alloc(MAX_FILE_BYTES, 0x61), Date.now(), true).kind).toBe("file");
  });
});

describe("a message with a file (web channel)", () => {
  it("files a .md exactly as iMessage does: incoming-files/<date>/HHMMSS_web_owner_<name>, and the same [Sent a file …] marker", async () => {
    const { channel, handled, workspace } = setup();
    const { uploadId } = stageUpload(dir, MD, Date.now(), true);
    const requestId = randomUUID();
    await channel.receive({ requestId, text: "read this", files: [{ id: uploadId, name: "notes.md", type: "text/markdown" }] });
    const text = handled[0].text;
    const path = /saved to (\S+)\. /.exec(text)![1];
    // Where: the shared inbound file store's own layout.
    const expected = buildFilePath(workspace, "text/markdown", { sessionKey: "web_owner", filename: "notes.md", timestamp: new Date() });
    expect(path.startsWith(`${expected.dir}/`)).toBe(true);
    expect(path).toMatch(new RegExp(`/memory/incoming-files/\\d{4}-\\d{2}-\\d{2}/\\d{6}_web_owner_notes\\.md$`));
    expect(readFileSync(path).equals(MD)).toBe(true);
    expect(statSync(path).mode & 0o111).toBe(0);
    // What the agent reads: the shared formatter's output, verbatim, then the typed text.
    const marker = formatFileMarker([{ filename: "notes.md", mimeType: "text/markdown", byteSize: MD.length, savedPath: path, status: "saved" }]);
    expect(text).toBe(`${marker} read this`);
    expect(marker).toBe(`[Sent a file: notes.md (text/markdown, ${MD.length} B) saved to ${path}. Contents not attached to this message — open the path if you need them.]`);
    // No bytes go to the model; the staged copy is gone; the request records where it was filed.
    expect(handled[0].images).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(channel.request(requestId).files).toEqual([{ path, name: "notes.md", type: "text/markdown", size: MD.length }]);
    await channel.stop();
  });
  it("sanitises the name: ../, absolute paths and NULs never leave incoming-files", async () => {
    const { channel, handled, workspace } = setup();
    const base = join(workspace, "memory", "incoming-files");
    for (const name of ["../../../etc/passwd", "/etc/hosts", "..\\..\\evil.sh", "safe.txt\0.sh", "..", ""]) {
      const { uploadId } = stageUpload(dir, MD, Date.now(), true);
      await channel.receive({ requestId: randomUUID(), text: "", files: [{ id: uploadId, name, type: "" }] });
    }
    const paths = handled.map((message) => /saved to (\S+)\. /.exec(message.text)![1]);
    for (const path of paths) {
      expect(path.startsWith(`${base}/`)).toBe(true);
      expect(path.slice(base.length + 1).split("/")).toHaveLength(2);
      expect(existsSync(path)).toBe(true);
      expect(path).not.toContain("\0");
    }
    expect(paths[0]).toMatch(/_web_owner_passwd$/);
    expect(paths[1]).toMatch(/_web_owner_hosts$/);
    expect(paths[2]).toMatch(/_web_owner_evil\.sh$/);
    expect(paths[3]).toMatch(/_web_owner_safe\.txt\.sh$/);
    // No type from the browser: reported like iMessage's MIME-less files.
    expect(handled[0].text).toContain("(type unknown, treated as application/octet-stream,");
    await channel.stop();
  });
  it("images and files together: images to the model and incoming-images, files by path — one marker each", async () => {
    const { channel, handled } = setup();
    const image = stageUpload(dir, PNG, Date.now(), true).uploadId;
    const file = stageUpload(dir, MD, Date.now(), true).uploadId;
    await channel.receive({ requestId: randomUUID(), text: "", images: [image], files: [{ id: file, name: "a.md", type: "text/markdown" }] });
    expect(handled[0].images).toHaveLength(1);
    expect(handled[0].text).toMatch(/^\[Sent an image, saved to: [^\]]+\] \[Sent a file: a\.md \(text\/markdown, [^)]+\) saved to [^\]]+\]$/);
    await channel.stop();
  });
  it("an id sent as the wrong kind, or files with saveInboundFiles off, refuses the message and moves nothing", async () => {
    const { channel, handled } = setup();
    const image = stageUpload(dir, PNG, Date.now(), true).uploadId;
    const file = stageUpload(dir, MD, Date.now(), true).uploadId;
    await expect(channel.receive({ requestId: randomUUID(), text: "x", files: [{ id: image, name: "a.png", type: "image/png" }] })).rejects.toMatchObject({ code: "upload_missing" });
    await expect(channel.receive({ requestId: randomUUID(), text: "x", images: [file] })).rejects.toMatchObject({ code: "upload_missing" });
    expect(readdirSync(dir).sort()).toEqual([`${image}.png`, `${file}.bin`].sort());
    const off = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(), { uploads: { dir, workspaceDir: join(root, "w") } });
    off.onMessage(vi.fn(async () => true));
    await expect(off.receive({ requestId: randomUUID(), text: "x", files: [{ id: file, name: "a.md", type: "text/markdown" }] })).rejects.toMatchObject({ code: "uploads_disabled" });
    expect(claimUploads(dir, [file], "t")).toBeDefined();
    expect(handled).toHaveLength(0);
    await channel.stop(); await off.stop();
  });
  it("after a restart an interrupted file-only request keeps where its file was filed", async () => {
    const path = join(root, "requests.jsonl");
    const first = setup(new WebRequestJournal(path));
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text: "", files: [{ id: stageUpload(dir, MD, Date.now(), true).uploadId, name: "n.md", type: "text/markdown" }] });
    const filed = first.channel.request(requestId).files!;
    await first.channel.stop();
    const again = new WebChannel({ name: "owner", telegram: ["test-owner"], imessage: [] }, new WatchBus(), { journal: new WebRequestJournal(path) });
    expect(again.request(requestId)).toMatchObject({ state: "interrupted", files: filed });
    await again.stop();
  });
  /** A request filed with `files`, then interrupted by a restart: what the owner resends from. */
  const interrupted = async (text: string, name: string) => {
    const journalPath = join(root, "requests.jsonl");
    const first = setup(new WebRequestJournal(journalPath));
    const requestId = randomUUID();
    await first.channel.receive({ requestId, text, files: [{ id: stageUpload(dir, MD, Date.now(), true).uploadId, name, type: "text/markdown" }] });
    const firstText = first.handled[0].text;
    await first.channel.stop();
    const again = setup(new WebRequestJournal(journalPath));
    const request = again.channel.request(requestId);
    expect(request.state).toBe("interrupted");
    return { ...again, request, firstText };
  };
  it("resending an interrupted text + file message re-attaches its filed file: the agent gets the same file marker, nothing re-uploaded", async () => {
    const { channel, handled, request, firstText } = await interrupted("see notes", "notes.md");
    // The page: the file comes back into the tray as it is, and is sent by path.
    const item = filedAttachment("k1", request.files![0]);
    const sent = captureSend([item]);
    expect(sent).toMatchObject({ keys: ["k1"], ids: [], files: [], refiled: [request.files![0].path] });
    const resend = { requestId: request.requestId, original: "see notes", fileKeys: ["k1"] };
    await channel.receive({ requestId: randomUUID(), text: "see notes", refiled: sent.refiled });
    expect(handled[0].text).toBe(firstText);
    expect(dismissAfterAcceptedSend(resend, "see notes", sent.keys)).toBe(request.requestId);
    // Still one copy on disk: the resend named the filed one.
    expect(readdirSync(join(root, "workspace", "memory", "incoming-files"), { recursive: true }).map(String).filter((n) => n.endsWith(".md"))).toHaveLength(1);
    await channel.stop();
  });
  it("resending an interrupted file-only message: re-attached by its file, the resend is recognised and the original dismissed", async () => {
    const { channel, handled, request, firstText } = await interrupted("", "only.md");
    const item = filedAttachment("k7", request.files![0]);
    const resend = { requestId: request.requestId, original: "", fileKeys: ["k7"] };
    // An empty draft does not cancel it; the send names the file; once accepted the original goes.
    expect(resendAfterDraftChange(resend, "")).toBe(resend);
    const sent = captureSend([item]);
    await channel.receive({ requestId: randomUUID(), text: "", refiled: sent.refiled });
    expect(handled[0].text).toBe(firstText);
    expect(dismissAfterAcceptedSend(resend, "", sent.keys)).toBe(request.requestId);
    expect(channel.resolveInterrupted(request.requestId, "dismissed").files).toBeUndefined();
    // Dismissed: its file can no longer be named.
    await expect(channel.receive({ requestId: randomUUID(), text: "", refiled: sent.refiled })).rejects.toMatchObject({ code: "upload_missing" });
    await channel.stop();
  });
  it("while a resend's images are still being restored, a send never counts as the resend: the original stays queued", () => {
    // Its file is back at once, its image is still being read back.
    const restoring = { requestId: "orig", original: "see both", fileKeys: ["f1"], restoring: true };
    expect(dismissAfterAcceptedSend(restoring, "see both", ["f1"])).toBeNull();
    expect(dismissAfterAcceptedSend({ ...restoring, original: "" }, "", ["f1"])).toBeNull();
    // An empty draft does not cancel a resend still restoring.
    expect(resendAfterDraftChange({ ...restoring, original: "", fileKeys: [] }, "")).not.toBeNull();
    // Restored: it counts only if the send took every re-attached item.
    const restored = { ...restoring, imageKeys: ["i1"], restoring: false };
    expect(dismissAfterAcceptedSend(restored, "see both", ["f1"])).toBeNull();
    expect(dismissAfterAcceptedSend(restored, "see both", ["f1", "i1"])).toBe("orig");
  });
  it("judged against the ORIGINAL's attachments: an image that failed to read back keeps the original queued", () => {
    // Original: one image + one file. The file came back; the image read failed (no key for it).
    const resend = { requestId: "orig", original: "both", fileKeys: ["f1"], imageKeys: [], restoring: false, expected: 2 };
    expect(missingAttachments(resend)).toBe(1);
    expect(dismissAfterAcceptedSend(resend, "both", ["f1"])).toBeNull();
    expect(dismissAfterAcceptedSend({ ...resend, original: "" }, "", ["f1"])).toBeNull();
  });
  it("a full tray that took only some of the original's images keeps the original queued", () => {
    let n = 0;
    const make = (f: File): Attachment => ({ key: `k${n++}`, file: f, preview: "", status: "uploading", progress: 0 });
    const full: Attachment[] = Array.from({ length: 5 }, (_, i) => make({ name: `x${i}.png`, type: "image/png", size: 1 } as File));
    const back = [1, 2, 3].map((i) => ({ name: `p${i}.png`, type: "image/png", size: 1 }) as File);
    const { added } = addFiles(full, back, make);
    expect(added).toHaveLength(1);
    const resend = { requestId: "orig", original: "three pictures", imageKeys: added.map((item) => item.key), restoring: false, expected: 3 };
    expect(missingAttachments(resend)).toBe(2);
    expect(dismissAfterAcceptedSend(resend, "three pictures", [...full.map((item) => item.key), ...resend.imageKeys])).toBeNull();
    // All back and all sent: then, and only then, it counts.
    expect(dismissAfterAcceptedSend({ ...resend, imageKeys: ["a", "b", "c"] }, "three pictures", ["a", "b", "c"])).toBe("orig");
  });
  it("A's restore finishing after the owner switched to B's resend never touches B: B stays locked, A's images are not B's", () => {
    const a = { requestId: "A", original: "a", restoring: true, expected: 1, token: 1 };
    const b = { requestId: "B", original: "b", restoring: true, expected: 1, token: 2 };
    // Current is B; A's late result arrives.
    expect(applyRestored(b, 1, ["imgA"])).toBe(b);
    expect(dismissAfterAcceptedSend(applyRestored(b, 1, ["imgA"]), "b", ["imgA"])).toBeNull();
    // B's own result applies.
    expect(applyRestored(b, 2, ["imgB"])).toMatchObject({ requestId: "B", imageKeys: ["imgB"], restoring: false });
    // Cancelled (no resend): a late result changes nothing.
    expect(applyRestored(null, 1, ["imgA"])).toBeNull();
    expect(applyRestored(a, 1, ["imgA"])).toMatchObject({ requestId: "A", restoring: false });
    // A send accepted as A ends A — but not B, started while it was in flight.
    expect(resendAfterSend(a, a)).toBeNull();
    expect(resendAfterSend(b, a)).toBe(b);
    expect(resendAfterSend(b, null)).toBe(b);
  });
  it("switching resend is one atomic tray change: A's items (files and images) out, B's in — a send then carries only B's", () => {
    const file = (path: string, name: string) => ({ path, name, type: "text/markdown", size: 1 });
    const image = (key: string, uploadId: string): Attachment => ({ key, file: { name: `${key}.png`, type: "image/png", size: 1 } as File, preview: "", kind: "image", status: "done", progress: 1, uploadId });
    const typed = image("mine", "u0");
    const tray = [typed, filedAttachment("fa", file("/f/a.md", "a.md")), image("ia", "uA")];
    const { next, dropped } = replaceItems(tray, ["fa", "ia"], [filedAttachment("fb", file("/f/b.md", "b.md"))]);
    expect(dropped.map((item) => item.key)).toEqual(["fa", "ia"]);
    const withB = [...next, image("ib", "uB")];
    const sent = captureSend(withB);
    expect(sent.refiled).toEqual(["/f/b.md"]);
    expect(sent.ids).toEqual(["u0", "uB"]);
  });
  it("refiled never names an arbitrary path: only files an interrupted request filed, still present", async () => {
    const { channel, handled, request } = await interrupted("x", "n.md");
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "s");
    for (const refiled of [[secret], ["/etc/passwd"], [`${request.files![0].path}/../../x`], [request.files![0].path, request.files![0].path]]) {
      await expect(channel.receive({ requestId: randomUUID(), text: "x", refiled })).rejects.toMatchObject({ code: "upload_missing" });
    }
    rmSync(request.files![0].path);
    await expect(channel.receive({ requestId: randomUUID(), text: "x", refiled: [request.files![0].path] })).rejects.toMatchObject({ code: "upload_missing" });
    expect(handled).toHaveLength(0);
    await channel.stop();
  });
  it("the schema: at most 6 files, ids only, a bounded name and type", () => {
    const base = { requestId: randomUUID(), text: "" };
    const ref = { id: "a".repeat(32), name: "n.md", type: "text/markdown" };
    expect(messageInputSchema.safeParse({ ...base, files: [ref] }).success).toBe(true);
    expect(messageInputSchema.safeParse({ ...base, files: Array(7).fill(ref) }).success).toBe(false);
    expect(messageInputSchema.safeParse({ ...base, files: [{ ...ref, id: "../x" }] }).success).toBe(false);
    expect(messageInputSchema.safeParse({ ...base, files: [{ ...ref, name: "x".repeat(1025) }] }).success).toBe(false);
    expect(messageInputSchema.safeParse({ ...base, files: [{ ...ref, extra: 1 }] }).success).toBe(false);
  });
});

describe("POST /uploads with files on: the same gate as images", () => {
  let service: Awaited<ReturnType<typeof startWebHttp>>;
  let cookie = "";
  let bootstrap: WebBootstrap;
  const accessToken = "tomo_web_" + "b".repeat(64);
  const EPOCH = "11111111-2222-3333-4444-555555555555";
  const call = (path: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}) =>
    new Promise<{ status: number; text: string; headers: HttpIncoming["headers"] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: service.port, path, method: options.method ?? "GET",
        headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...options.headers } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
        res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
      });
      // An oversized body is answered (413) before it is all sent; the rest of the write then fails — expected.
      req.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET" && (error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
      req.on("socket", (socket) => socket.on("error", () => {}));
      req.end(options.body);
    });
  const upload = (body: Buffer, override: Record<string, string> = {}, target = webSessionId("dm:owner")) => call(`/api/v1/uploads?targetId=${encodeURIComponent(target)}`, {
    method: "POST", body, headers: { origin: `http://127.0.0.1:${service.port}`, "content-type": "application/octet-stream",
      "x-tomo-csrf": bootstrap.csrfToken, "x-tomo-epoch": EPOCH, ...override } });
  beforeEach(async () => {
    cookie = "";
    const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk"), assetsDir = join(root, "assets");
    mkdirSync(assetsDir, { recursive: true }); writeFileSync(join(assetsDir, "index.html"), "<!doctype html>");
    service = await startWebHttp(0, { accessToken, assetsDir, data: new WebData({ sessionsDir, sdkSessionsDir, owner: { name: "owner", telegram: ["test-owner"], imessage: [] } }),
      uploadsDir: dir, uploadKinds: { images: true, files: true }, subscribe: () => () => {},
      rpc: async (input) => (input.method === "epoch" ? EPOCH : { snapshot: { requests: [], blocks: [] }, replay: null }) });
    const response = await call(`/api/v1/bootstrap?t=${accessToken}`);
    bootstrap = JSON.parse(response.text);
    cookie = response.headers["set-cookie"]![0].split(";")[0];
  });
  afterEach(async () => { await service?.close(); });
  it("offers files, stages a .md as a file, and refuses without CSRF, for another conversation, on a new epoch, or over the cap", async () => {
    expect(bootstrap.capabilities).toMatchObject({ uploads: true, files: true });
    const ok = await upload(MD);
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.text)).toMatchObject({ kind: "file", size: MD.length });
    expect((await upload(MD, { "x-tomo-csrf": "nope" })).status).toBe(403);
    expect((await upload(MD, {}, "someone-else")).status).toBe(403);
    expect((await upload(MD, { "x-tomo-epoch": "99999999-2222-3333-4444-555555555555" })).status).toBe(409);
    const big = await upload(Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    expect(big.status).toBe(413);
    expect(JSON.parse(big.text).error).toBe("too_large");
    expect(readdirSync(dir)).toHaveLength(1);
  });
  it("GET /uploads/<id> gives a reloaded page back what it staged (an image's bytes, a file's size) — owner session only, never a claimed or unknown one", async () => {
    const image = JSON.parse((await upload(PNG)).text).uploadId as string;
    const file = JSON.parse((await upload(MD)).text).uploadId as string;
    const got = await call(`/api/v1/uploads/${image}`);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    const info = await call(`/api/v1/uploads/${file}`);
    expect(info.status).toBe(200);
    expect(JSON.parse(info.text)).toEqual({ kind: "file", size: MD.length });
    // Not the access cookie: refused like any API read.
    const saved = cookie; cookie = "";
    expect((await call(`/api/v1/uploads/${image}`)).status).toBe(401);
    cookie = saved;
    // Without the API header (an <img> or a navigation from another site): refused.
    expect((await call(`/api/v1/uploads/${image}`, { headers: { "x-tomo-request": "" } })).status).toBeGreaterThanOrEqual(400);
    for (const bad of ["0".repeat(32), "../uploads", `${image}.png`, image.toUpperCase()]) expect((await call(`/api/v1/uploads/${encodeURIComponent(bad)}`)).status).toBe(404);
    // Claimed by a message (sent): gone for the page too.
    const claim = claimUploads(dir, [image], "req-1")!;
    expect((await call(`/api/v1/uploads/${image}`)).status).toBe(404);
    claim.release();
    expect((await call(`/api/v1/uploads/${image}`)).status).toBe(200);
  });
});

describe("GET /sessions/<id>/outgoing/<id>: a file the agent sent is only ever a download", () => {
  let service: Awaited<ReturnType<typeof startWebHttp>>;
  let cookie = "";
  const accessToken = "tomo_web_" + "c".repeat(64);
  const call = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Buffer; headers: HttpIncoming["headers"] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: service.port, path, method: "GET",
        headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty", ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
        const parts: Buffer[] = []; res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(parts), headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
  it("served as application/octet-stream with Content-Disposition: attachment and a sandbox CSP; a picture is still an image; same gate as the rest", async () => {
    const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk"), assetsDir = join(root, "assets"), workspace = join(root, "workspace");
    mkdirSync(assetsDir, { recursive: true }); writeFileSync(join(assetsDir, "index.html"), "<!doctype html>");
    const { SessionStore } = await import("../src/sessions/store.js");
    new SessionStore(sessionsDir, 20, sdkSessionsDir).setSdkSessionId("dm:owner", "sdk-1");
    const { OutgoingMediaStore, outgoingImagesDir } = await import("../src/web/outgoing-media.js");
    const store = new OutgoingMediaStore(outgoingImagesDir(workspace));
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    const html = store.file("dm:owner", ["r"], join(root, "page.html"));
    writeFileSync(join(root, "pic.png"), PNG);
    const pic = store.file("dm:owner", ["r"], join(root, "pic.png"));
    service = await startWebHttp(0, { accessToken, assetsDir, data: new WebData({ sessionsDir, sdkSessionsDir, workspaceDir: workspace, owner: { name: "owner", telegram: ["test-owner"], imessage: [] } }),
      subscribe: () => () => {}, rpc: async () => ({ snapshot: { requests: [], blocks: [] }, replay: null }) });
    const boot = await new Promise<HttpIncoming>((resolve) => request({ host: "127.0.0.1", port: service.port, path: `/api/v1/bootstrap?t=${accessToken}`, headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } }, resolve).end());
    boot.resume();
    cookie = boot.headers["set-cookie"]![0].split(";")[0];
    const sid = webSessionId("dm:owner");
    const got = await call(`/api/v1/sessions/${sid}/outgoing/${html.id}`);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["content-disposition"]).toBe('attachment; filename="page.html"');
    expect(got.headers["content-security-policy"]).toContain("sandbox");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.body.toString()).toBe("<script>alert(1)</script>");
    const image = await call(`/api/v1/sessions/${sid}/outgoing/${pic.id}`, { "sec-fetch-dest": "image" });
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-disposition"]).toBeUndefined();
    // A navigation (another site, or a top-level open) is refused; so is no cookie, another session, a bent id.
    expect((await call(`/api/v1/sessions/${sid}/outgoing/${html.id}`, { "sec-fetch-dest": "document" })).status).toBe(403);
    expect((await call(`/api/v1/sessions/${sid}/outgoing/${html.id}`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(`/api/v1/sessions/${webSessionId("telegram:-1")}/outgoing/${html.id}`)).status).toBe(404);
    expect((await call(`/api/v1/sessions/${sid}/outgoing/..%2Findex`)).status).toBeGreaterThanOrEqual(400);
    cookie = "";
    expect((await call(`/api/v1/sessions/${sid}/outgoing/${html.id}`)).status).toBe(401);
    await service.close();
  });
});

describe("the page's side", () => {
  const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;
  it("with files on, any file may be attached (images still as images); the cap is 32 MB", () => {
    let n = 0;
    const make = (f: File): Attachment => ({ key: `k${n++}`, file: f, preview: "", status: "uploading", progress: 0 });
    const out = addFiles([], [file("notes.md", "text/markdown"), file("a.png", "image/png"), file("huge.zip", "application/zip", 33 * 1024 * 1024)], make, { images: true, files: true });
    expect(out.next.map((item) => item.file.name)).toEqual(["notes.md", "a.png"]);
    expect(noteText(out.note)).toContain("Files must be under 32 MB.");
    expect(addFiles([], [file("notes.md", "text/markdown")], make).next).toHaveLength(0);
    const md = file("notes.md", "text/markdown");
    expect(pastedFiles([{ kind: "string", type: "text/plain", getAsFile: () => null }, { kind: "file", type: "text/markdown", getAsFile: () => md }])).toEqual([md]);
  });
  it("a send names images by id and files by id, name and type", () => {
    const items: Attachment[] = [
      { key: "a", file: file("a.png", "image/png"), preview: "", status: "done", progress: 1, uploadId: "u1", kind: "image" },
      { key: "b", file: file("n.md", "text/markdown"), preview: "", status: "done", progress: 1, uploadId: "u2", kind: "file" },
    ];
    expect(captureSend(items)).toEqual({ keys: ["a", "b"], ids: ["u1"], files: [{ id: "u2", name: "n.md", type: "text/markdown" }], refiled: [] });
    expect(formatSize(820)).toBe("820 B");
    expect(formatSize(14_540)).toBe("14.2 KB");
  });
  it("the history reads the server's file marker back as a card per file (name and size), never the path", () => {
    const marker = formatFileMarker([
      { filename: "notes.md", mimeType: "text/markdown", byteSize: 1234, savedPath: "/w/memory/incoming-files/2026-11-15/101010_web_owner_notes.md", status: "saved" },
      { filename: "blob", mimeType: "application/octet-stream", mimeUnknown: true, byteSize: 5, savedPath: "/w/memory/incoming-files/2026-11-15/101010_web_owner_blob", status: "saved" },
    ]);
    const parts = splitAttachments(`${marker} hi`);
    expect(parts[0]).toEqual({ kind: "attachment", label: "2 files", names: ["notes.md", "blob"], files: [{ name: "notes.md", size: "1.2 KB" }, { name: "blob", size: "5 B" }] });
    expect(parts[1]).toEqual({ kind: "text", text: "hi" });
  });
});
