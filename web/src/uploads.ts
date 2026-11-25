import type { WebFiledFile } from "../../src/web/protocol.js";
import { i18n } from "./i18n/index.js";
import { deferred, say, type Message } from "./i18n/message.js";

/**
 * Files attached in the composer ("+", drop, paste): pure state, kept out of
 * React so it is testable. Each picked file is uploaded at once
 * (POST /uploads); the message names the finished uploads' ids. Images show
 * as thumbnails and go to the model; any other file shows as a chip and is
 * filed for the agent by path (as iMessage's are).
 * Limits mirror the server's (src/web/uploads.ts).
 */
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Non-image files: the server's MAX_UPLOAD_FILE_BYTES (the iMessage inbound file cap). */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);

export type AttachmentStatus = "uploading" | "done" | "failed";
export interface Attachment {
  key: string;
  file: File;
  /** An object URL for the thumbnail (revoked when the attachment goes); "" for a non-image file. */
  preview: string;
  /** "file": not an image (a chip, filed by path). Absent: an image. Set from the server's answer once uploaded. */
  kind?: "image" | "file";
  status: AttachmentStatus;
  /** 0–1 while uploading. */
  progress: number;
  uploadId?: string;
  /** Why the upload failed, worded when shown. */
  error?: Message;
  /** Resending an interrupted message: a file it already filed, attached again from where it is (no upload). */
  filed?: WebFiledFile;
  /** Kept across a reload and being read back from the server (see KeptUpload): never uploaded again; Retry reads it again. */
  restore?: KeptUpload;
}

/** Whether a picked/dropped/pasted file may be attached (by its declared type; the server checks the bytes). */
export function isAttachableImage(file: { type: string; name: string }): boolean {
  if (TYPES.has(file.type.toLowerCase())) return true;
  // Some browsers leave HEIC untyped.
  return !file.type && /\.(heic|heif)$/i.test(file.name);
}

/** The files among clipboard / drag items — any type (text items are left alone, so text pastes as usual). */
export function pastedFiles(items: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null | undefined): File[] {
  const files: File[] = [];
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** The image files among clipboard / drag items (text items are left alone, so text pastes as usual). */
export function imageFiles(items: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null | undefined): File[] {
  const files: File[] = [];
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isAttachableImage(file)) files.push(file);
  }
  return files;
}

/** A drag carries files (so the chat shows "Drop to attach"); a text or link drag does not. */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return Array.from(types ?? []).includes("Files");
}

/**
 * Add files to the tray: images (each at most MAX_ATTACHMENT_BYTES) and,
 * with `allow.files`, any other file (at most MAX_FILE_BYTES), at most
 * MAX_ATTACHMENTS in all. Returns what was kept and a note for the rest.
 */
export function addFiles(current: readonly Attachment[], files: readonly File[], make: (file: File) => Attachment,
  allow: { images?: boolean; files?: boolean } = { images: true }):
  { next: Attachment[]; added: Attachment[]; note: Message[] } {
  const added: Attachment[] = [];
  let skippedType = 0, skippedSize = 0, skippedFileSize = 0, skippedCount = 0;
  for (const file of files) {
    // Images off but files on: a picture goes as a plain file.
    const image = allow.images !== false && isAttachableImage(file);
    if (!image && !allow.files) { skippedType++; continue; }
    if (image && file.size > MAX_ATTACHMENT_BYTES) { skippedSize++; continue; }
    if (!image && file.size > MAX_FILE_BYTES) { skippedFileSize++; continue; }
    if (current.length + added.length >= MAX_ATTACHMENTS) { skippedCount++; continue; }
    added.push(make(file));
  }
  const notes = [
    skippedCount ? (allow.files ? deferred.t("chat:attach.maxAttachments", { count: MAX_ATTACHMENTS }) : deferred.t("chat:attach.maxImages", { count: MAX_ATTACHMENTS })) : null,
    skippedSize ? deferred.t("chat:attach.imageSize", { mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }) : null,
    skippedFileSize ? deferred.t("chat:attach.fileSize", { mb: MAX_FILE_BYTES / 1024 / 1024 }) : null,
    skippedType ? deferred.t("chat:attach.types") : null,
  ].filter((note): note is Message => note !== null);
  return { next: [...current, ...added], added, note: notes };
}

export function updateAttachment(list: readonly Attachment[], key: string, change: Partial<Attachment>): Attachment[] {
  return list.map((item) => (item.key === key ? { ...item, ...change } : item));
}

/** Ready to send: nothing still uploading or failed, and something to say (text or a finished image). */
export function canSendWith(text: string, list: readonly Attachment[]): boolean {
  if (list.some((item) => item.status !== "done")) return false;
  return text.trim().length > 0 || list.length > 0;
}

export function uploadIds(list: readonly Attachment[]): string[] {
  return list.flatMap((item) => (item.status === "done" && item.uploadId ? [item.uploadId] : []));
}

/** The tray's note about files that were not added, in the current language. */
export function noteText(notes: readonly Message[]): string {
  return notes.map(say).join(" ");
}

/** What a screen reader hears for a tray item. */
export function attachmentLabel(item: Attachment, index: number): string {
  const name = item.file.name || (item.kind === "file" ? i18n.t("chat:attach.fileN", { n: index + 1 }) : i18n.t("chat:attach.imageN", { n: index + 1 }));
  if (item.status === "uploading") return i18n.t("chat:attach.uploading", { name, percent: Math.round(item.progress * 100) });
  if (item.status === "failed") return i18n.t("chat:attach.uploadFailed", { name });
  return i18n.t("chat:attach.attached", { name });
}

/** What a send captured, split from what was added meanwhile (which stays in the tray). */
export function takeSent(list: readonly Attachment[], keys: readonly string[]): { taken: Attachment[]; kept: Attachment[] } {
  const sent = new Set(keys);
  return { taken: list.filter((item) => sent.has(item.key)), kept: list.filter((item) => !sent.has(item.key)) };
}

/**
 * Captured when Send is pressed: the finished attachments' keys, the images'
 * upload ids, and the other files' ids with the name and type the message
 * carries for them — each in order.
 */
export function captureSend(list: readonly Attachment[]): { keys: string[]; ids: string[]; files: Array<{ id: string; name: string; type: string }>; refiled: string[] } {
  const done = list.filter((item) => item.status === "done" && (item.uploadId || item.filed));
  const uploaded = done.filter((item) => item.uploadId);
  return { keys: done.map((item) => item.key), ids: uploaded.filter((item) => item.kind !== "file").map((item) => item.uploadId!),
    files: uploaded.filter((item) => item.kind === "file").map((item) => ({ id: item.uploadId!, name: item.file.name, type: item.file.type })),
    refiled: done.flatMap((item) => (item.filed ? [item.filed.path] : [])) };
}

/**
 * What a tab keeps of its tray across a reload (sessionStorage): the
 * finished uploads, by id, with the name, type and size the message needs.
 * iPad Safari reloads a backgrounded tab freely; without this the tray came
 * back empty while its uploads sat staged on the server, and the next
 * message went without them.
 */
export interface KeptUpload { uploadId: string; kind: "image" | "file"; name: string; type: string; size: number }
export function keptUploads(list: readonly Attachment[]): KeptUpload[] {
  // One still being read back stays kept whatever its state: until the server says it is gone, it is not.
  return list.flatMap((item) => item.restore ? [item.restore] : item.status === "done" && item.uploadId && !item.filed
    ? [{ uploadId: item.uploadId, kind: item.kind ?? "image", name: item.file.name, type: item.file.type, size: item.file.size }] : []);
}
/** A kept upload in the tray while it is read back: counted, shown as uploading, and blocking Send like one. */
export function restoringAttachment(key: string, kept: KeptUpload): Attachment {
  return { key, file: { name: kept.name, type: kept.type, size: kept.size } as File, preview: "", kind: kept.kind, status: "uploading", progress: 0, uploadId: kept.uploadId, restore: kept };
}
export function parseKeptUploads(raw: string | null): KeptUpload[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is KeptUpload => !!item && typeof item === "object"
      && typeof item.uploadId === "string" && /^[a-f0-9]{32}$/.test(item.uploadId) && (item.kind === "image" || item.kind === "file")
      && typeof item.name === "string" && item.name.length <= 1024 && typeof item.type === "string" && item.type.length <= 255
      && typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0).slice(0, MAX_ATTACHMENTS);
  } catch { return []; }
}
/** A kept upload back in the tray, finished: `preview` is its thumbnail (an object URL), "" for a file. */
export function restoredAttachment(key: string, kept: KeptUpload, preview: string, size = kept.size): Attachment {
  return { key, file: { name: kept.name, type: kept.type, size } as File, preview, kind: kept.kind, status: "done", progress: 1, uploadId: kept.uploadId };
}

/** One atomic tray change: `dropKeys` leave, `added` come in (order kept). Returns what was dropped, for its cleanup. */
export function replaceItems(current: readonly Attachment[], dropKeys: readonly string[], added: readonly Attachment[]): { next: Attachment[]; dropped: Attachment[] } {
  const drop = new Set(dropKeys);
  return { next: [...current.filter((item) => !drop.has(item.key)), ...added], dropped: current.filter((item) => drop.has(item.key)) };
}

/** A tray item for a file an interrupted message already filed (resend): done at once, nothing to upload. */
export function filedAttachment(key: string, filed: WebFiledFile): Attachment {
  return { key, file: { name: filed.name, type: filed.type, size: filed.size } as File, preview: "", kind: "file", status: "done", progress: 1, filed };
}

/** A byte count as a chip shows it — the same form as the server's file marker (fileStore formatBytes: "820 B", "14.2 KB"). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
