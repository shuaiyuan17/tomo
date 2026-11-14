import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store.js";
import { imagePaths, WebData } from "../src/web/data.js";
import { webSessionId } from "../src/web/owner.js";

let root: string, workspaceDir: string, data: WebData, ownerId: string;
const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tomo-media-"));
  workspaceDir = join(root, "workspace");
  const images = join(workspaceDir, "memory", "incoming-images", "2026-11-14");
  mkdirSync(images, { recursive: true });
  mkdirSync(join(workspaceDir, "memory", "private"), { recursive: true });
  writeFileSync(join(images, "a.png"), PNG);
  writeFileSync(join(workspaceDir, "memory", "private", "secret.png"), PNG);
  writeFileSync(join(root, "outside.png"), PNG);
  symlinkSync(join(root, "outside.png"), join(images, "link.png"));
  const sessionsDir = join(root, "sessions"), sdkSessionsDir = join(root, "sdk");
  const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
  const shown = [join(images, "a.png"), join(images, "link.png"), join(images, "../../private/secret.png"), join(workspaceDir, "memory", "private", "secret.png")];
  store.append("dm:owner", { role: "user", channel: "telegram", timestamp: 1, content: `[Sent ${shown.length} images, saved to: ${shown.join(", ")}] look` });
  data = new WebData({ sessionsDir, sdkSessionsDir, owner, workspaceDir });
  ownerId = webSessionId("dm:owner");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("inbound images for the web UI", () => {
  it("parses image and sticker markers", () => {
    expect(imagePaths("[Sent 2 images, saved to: /a/1.png, /a/2.jpg; 1 still downloading — will follow]")).toEqual(["/a/1.png", "/a/2.jpg"]);
    expect(imagePaths("[Sent a sticker, saved to: /s.png; resend with STICKER:<saved path>]")).toEqual(["/s.png"]);
    expect(imagePaths("[Sent a document, saved to: /d.pdf]")).toEqual([]);
  });
  it("serves an image named in a served history page, and nothing else", async () => {
    const good = join(workspaceDir, "memory", "incoming-images", "2026-11-14", "a.png");
    // Not yet named by a page this process served.
    await expect(data.mediaFile(ownerId, good)).rejects.toMatchObject({ status: 404 });
    await data.history(ownerId);
    expect(await data.mediaFile(ownerId, good)).toMatchObject({ type: "image/png" });
    // Another session cannot borrow the path.
    await expect(data.mediaFile(webSessionId("telegram:-1"), good)).rejects.toMatchObject({ status: 404 });
  });
  it("refuses traversal, symlinks out, private memory, and paths never shown", async () => {
    await data.history(ownerId);
    const images = join(workspaceDir, "memory", "incoming-images", "2026-11-14");
    await expect(data.mediaFile(ownerId, join(images, "../../private/secret.png"))).rejects.toMatchObject({ status: 404 });
    await expect(data.mediaFile(ownerId, join(workspaceDir, "memory", "private", "secret.png"))).rejects.toMatchObject({ status: 404 });
    await expect(data.mediaFile(ownerId, join(images, "link.png"))).rejects.toMatchObject({ status: 404 });
    await expect(data.mediaFile(ownerId, join(root, "outside.png"))).rejects.toMatchObject({ status: 404 });
  });
});
