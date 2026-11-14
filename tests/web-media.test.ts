import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store.js";
import { imagePaths, imageSessionKeys, MAX_MESSAGE_IMAGES, sniffImageType, WebData } from "../src/web/data.js";
import { buildImagePath } from "../src/channels/imageStore.js";
import { webSessionId } from "../src/web/owner.js";

let root: string, workspaceDir: string, images: string, data: WebData, store: SessionStore, ownerId: string;
const owner = { name: "owner", telegram: ["test-owner"], imessage: ["+15550001111"] };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/** A filename exactly as the image store names it for a channel's meta.sessionKey. */
const name = (sessionKey: string, guid = "abcd-1234-ef") =>
  buildImagePath("/unused", "image/png", { sessionKey, guid, timestamp: new Date(2026, 10, 14, 12, 35, 33) } as never).filename;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-media-"));
  workspaceDir = join(root, "workspace");
  images = join(workspaceDir, "memory", "incoming-images", "2026-11-14");
  mkdirSync(images, { recursive: true });
  mkdirSync(join(workspaceDir, "memory", "private"), { recursive: true });
  const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
  store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
  data = new WebData({ sessionsDir, sdkSessionsDir, owner, workspaceDir });
  ownerId = webSessionId("dm:owner");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const inbound = (paths: string[], extra: Partial<{ role: "user" | "assistant"; channel: string; text: string }> = {}) =>
  store.append("dm:owner", { role: extra.role ?? "user", channel: extra.channel ?? "telegram", timestamp: Date.now(),
    content: extra.text ?? `[Sent ${paths.length} images, saved to: ${paths.join(", ")}] look` });

describe("which images the web may serve", () => {
  it("only an inbound channel message's leading marker, capped", () => {
    expect(imagePaths("[Sent 2 images, saved to: /a/1.png, /a/2.jpg; 1 still downloading]")).toEqual(["/a/1.png", "/a/2.jpg"]);
    expect(imagePaths("[via satellite] [Sent a sticker, saved to: /s.png; resend with STICKER:<saved path>]")).toEqual(["/s.png"]);
    expect(imagePaths("look at this [Sent an image, saved to: /typed.png]")).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `/p/${i}.png`);
    expect(imagePaths(`[Sent 30 images, saved to: ${many.join(", ")}]`)).toHaveLength(MAX_MESSAGE_IMAGES);
  });
  it("a session's images are those filed under its own channel chats", () => {
    expect(imageSessionKeys("telegram:-100200", undefined, false)).toEqual(["telegram_-100200"]);
    expect(imageSessionKeys("dm:owner", owner, true)).toContain("imessage_any;-;+15550001111");
  });
  it("a session id must match whole: chat 123 never claims chat 1234's images", async () => {
    const { isImageFiledFor } = await import("../src/channels/imageStore.js");
    const of1234 = name("telegram_-1001234");
    expect(isImageFiledFor(of1234, ["telegram_-100123"])).toBe(false);
    expect(isImageFiledFor(of1234, ["telegram_-1001234"])).toBe(true);
    expect(isImageFiledFor(of1234.replace(".png", "-2.png"), ["telegram_-1001234"])).toBe(true);
  });
  it("matches the owner's iMessage handle through the shared normaliser", async () => {
    const { isImageFiledFor } = await import("../src/channels/imageStore.js");
    const keys = imageSessionKeys("dm:owner", { name: "owner", telegram: [], imessage: ["+15551234567"] }, true);
    expect(isImageFiledFor(name("imessage_iMessage;-;15551234567"), keys)).toBe(true);
    expect(isImageFiledFor(name("imessage_any;-;+15551234567"), keys)).toBe(true);
    expect(isImageFiledFor(name("imessage_any;-;+15551234568"), keys)).toBe(false);
  });
  it("sniffs real image signatures (never SVG)", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("\0\0\0\x18ftypheic"))).toBe("image/heic");
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
  });
});

describe("mediaFile", () => {
  it("serves an inbound image of this session's chat, once a served page named it", async () => {
    const good = join(images, name("telegram_test-owner"));
    // Real-world shapes: an iMessage chat GUID with ; and +, a path-like guid, a collision suffix.
    const viaImessage = join(images, name("imessage_any;-;+15550001111", "/Library/Messages/Attachments/x"));
    const collided = viaImessage.replace(/\.png$/, "-1.png");
    writeFileSync(good, PNG); writeFileSync(viaImessage, PNG); writeFileSync(collided, PNG);
    inbound([good, viaImessage, collided]);
    await expect(data.mediaFile(ownerId, good)).rejects.toMatchObject({ status: 404 });
    await data.history(ownerId);
    expect(await data.mediaFile(ownerId, good)).toMatchObject({ type: "image/png" });
    expect(await data.mediaFile(ownerId, viaImessage)).toMatchObject({ type: "image/png" });
    expect(await data.mediaFile(ownerId, collided)).toMatchObject({ type: "image/png" });
    await expect(data.mediaFile(webSessionId("telegram:-1"), good)).rejects.toMatchObject({ status: 404 });
  });
  it("ignores look-alike markers: typed by the owner on the web, written by Tomo, or not leading", async () => {
    const good = join(images, name("telegram_test-owner"));
    writeFileSync(good, PNG);
    inbound([good], { channel: "web" });
    inbound([good], { role: "assistant" });
    inbound([good], { text: `see [Sent an image, saved to: ${good}]` });
    await data.history(ownerId);
    await expect(data.mediaFile(ownerId, good)).rejects.toMatchObject({ status: 404 });
  });
  it("refuses another chat's file, traversal, symlinks, hard links, private memory and wrong signatures", async () => {
    const other = join(images, name("telegram_-999"));
    // Another iMessage chat whose GUID merely contains the owner's handle digits elsewhere.
    const otherChat = join(images, name("imessage_any;+;chat15550001111"));
    const link = join(images, name("telegram_test-owner", "link-0001"));
    const hard = join(images, name("telegram_test-owner", "hard-0001"));
    const fake = join(images, name("telegram_test-owner", "fake-0001"));
    const secret = join(workspaceDir, "memory", "private", name("telegram_test-owner", "priv-0001"));
    const traversal = join(images, "..", "..", "private", name("telegram_test-owner", "priv-0001"));
    writeFileSync(other, PNG); writeFileSync(otherChat, PNG); writeFileSync(secret, PNG); writeFileSync(join(root, "outside.png"), PNG);
    symlinkSync(join(root, "outside.png"), link);
    writeFileSync(join(root, "elsewhere.png"), PNG); linkSync(join(root, "elsewhere.png"), hard);
    writeFileSync(fake, "<svg/>");
    inbound([other, otherChat, link, hard, fake, secret, traversal]);
    await data.history(ownerId);
    for (const path of [other, otherChat, link, hard, fake, secret, traversal]) await expect(data.mediaFile(ownerId, path)).rejects.toMatchObject({ status: 404 });
  });
});
