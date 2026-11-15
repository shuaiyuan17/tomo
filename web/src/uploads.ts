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
  error?: string;
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
  { next: Attachment[]; added: Attachment[]; note: string } {
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
    skippedCount && `Up to ${MAX_ATTACHMENTS} ${allow.files ? "attachments" : "images"} per message.`,
    skippedSize && `Images must be under ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
    skippedFileSize && `Files must be under ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
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
  const name = item.file.name || `${item.kind === "file" ? "File" : "Image"} ${index + 1}`;
  if (item.status === "uploading") return `${name}, uploading ${Math.round(item.progress * 100)}%`;
  if (item.status === "failed") return `${name}, upload failed`;
  return `${name}, attached`;
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
export function captureSend(list: readonly Attachment[]): { keys: string[]; ids: string[]; files: Array<{ id: string; name: string; type: string }> } {
  const done = list.filter((item) => item.status === "done" && item.uploadId);
  return { keys: done.map((item) => item.key), ids: done.filter((item) => item.kind !== "file").map((item) => item.uploadId!),
    files: done.filter((item) => item.kind === "file").map((item) => ({ id: item.uploadId!, name: item.file.name, type: item.file.type })) };
}

/** A byte count as a chip shows it — the same form as the server's file marker (fileStore formatBytes: "820 B", "14.2 KB"). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
