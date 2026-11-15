/**
 * Images attached in the composer (button, drop, paste): pure state, kept
 * out of React so it is testable. Each picked file is uploaded at once
 * (POST /uploads); the message names the finished uploads' ids.
 * Limits mirror the server's (src/web/uploads.ts).
 */
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);

export type AttachmentStatus = "uploading" | "done" | "failed";
export interface Attachment {
  key: string;
  file: File;
  /** An object URL for the thumbnail (revoked when the attachment goes). */
  preview: string;
  status: AttachmentStatus;
  /** 0–1 while uploading. */
  progress: number;
  uploadId?: string;
  error?: string;
}

/** Whether a picked/dropped/pasted file may be attached (by its declared type; the server checks the bytes). */
export function isAttachableImage(file: { type: string; name: string }): boolean {
  if (TYPES.has(file.type.toLowerCase())) return true;
  // Some browsers leave HEIC untyped.
  return !file.type && /\.(heic|heif)$/i.test(file.name);
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
 * Add files to the tray: images only, each at most MAX_ATTACHMENT_BYTES, at
 * most MAX_ATTACHMENTS in all. Returns what was kept and a note for the rest.
 */
export function addFiles(current: readonly Attachment[], files: readonly File[], make: (file: File) => Attachment):
  { next: Attachment[]; added: Attachment[]; note: string } {
  const added: Attachment[] = [];
  let skippedType = 0, skippedSize = 0, skippedCount = 0;
  for (const file of files) {
    if (!isAttachableImage(file)) { skippedType++; continue; }
    if (file.size > MAX_ATTACHMENT_BYTES) { skippedSize++; continue; }
    if (current.length + added.length >= MAX_ATTACHMENTS) { skippedCount++; continue; }
    added.push(make(file));
  }
  const notes = [
    skippedCount && `Up to ${MAX_ATTACHMENTS} images per message.`,
    skippedSize && `Images must be under ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
    skippedType && "Only PNG, JPEG, GIF, WebP and HEIC images can be attached.",
  ].filter(Boolean);
  return { next: [...current, ...added], added, note: notes.join(" ") };
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

/** What a screen reader hears for a tray item. */
export function attachmentLabel(item: Attachment, index: number): string {
  const name = item.file.name || `Image ${index + 1}`;
  if (item.status === "uploading") return `${name}, uploading ${Math.round(item.progress * 100)}%`;
  if (item.status === "failed") return `${name}, upload failed`;
  return `${name}, attached`;
}

/** What a send captured, split from what was added meanwhile (which stays in the tray). */
export function takeSent(list: readonly Attachment[], keys: readonly string[]): { taken: Attachment[]; kept: Attachment[] } {
  const sent = new Set(keys);
  return { taken: list.filter((item) => sent.has(item.key)), kept: list.filter((item) => !sent.has(item.key)) };
}

/** Captured when Send is pressed: the finished attachments' keys and upload ids, in order. */
export function captureSend(list: readonly Attachment[]): { keys: string[]; ids: string[] } {
  const done = list.filter((item) => item.status === "done" && item.uploadId);
  return { keys: done.map((item) => item.key), ids: done.map((item) => item.uploadId!) };
}
