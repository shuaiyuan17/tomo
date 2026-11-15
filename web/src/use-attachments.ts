import { useCallback, useEffect, useRef, useState } from "react";
import type { WebBootstrap } from "./api.js";
import { ApiError, discardUpload, uploadImage } from "./api.js";
import { addFiles, isAttachableImage, takeSent, updateAttachment, type Attachment } from "./uploads.js";

const failure = (error: unknown) => {
  if (!(error instanceof ApiError)) return "Upload failed";
  return error.code === "not_image" ? "Not an image this can send"
    : error.code === "too_large" ? "Too large (images 20 MB, other files 32 MB at most)"
    : error.code === "uploads_disabled" ? "Attachments are off in config"
    : error.code === "epoch_changed" ? "Tomo restarted — try again"
    : error.code === "upload_limit" ? "Too many uploads waiting — send or remove some" : "Upload failed";
};

/**
 * The composer's attachment tray: each file uploads as soon as it is added;
 * failed ones can be retried. `allow`: which kinds the daemon keeps (bootstrap capabilities).
 */
export function useAttachments(bootstrap: WebBootstrap | undefined, refresh: () => Promise<WebBootstrap>, targetId: string | undefined,
  allow: { images: boolean; files: boolean } = { images: true, files: false }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [note, setNote] = useState("");
  const list = useRef(items);
  list.current = items;
  const aborts = useRef(new Map<string, AbortController>());
  const counter = useRef(0);

  const upload = useCallback((item: Attachment) => {
    if (!bootstrap || !targetId) { setItems((old) => updateAttachment(old, item.key, { status: "failed", error: "Not connected" })); return; }
    const controller = new AbortController();
    aborts.current.set(item.key, controller);
    setItems((old) => updateAttachment(old, item.key, { status: "uploading", progress: 0, error: undefined }));
    uploadImage(item.file, targetId, bootstrap, refresh, (progress) => setItems((old) => updateAttachment(old, item.key, { progress })), controller.signal)
      .then((value) => {
        if (!list.current.some((entry) => entry.key === item.key)) { discardUpload(value.uploadId, bootstrap); return; }
        // The server decides what it is by its bytes: a file the browser called an image may come back a plain file.
        const kind = value.kind ?? "image";
        if (kind === "file" && item.preview) URL.revokeObjectURL(item.preview);
        setItems((old) => updateAttachment(old, item.key, { status: "done", progress: 1, uploadId: value.uploadId, kind, ...(kind === "file" ? { preview: "" } : {}) }));
      }, (error) => {
        if (controller.signal.aborted) return;
        setItems((old) => updateAttachment(old, item.key, { status: "failed", error: failure(error) }));
      })
      .finally(() => aborts.current.delete(item.key));
  }, [bootstrap, refresh, targetId]);

  /** Returns the keys of the attachments added. */
  const add = useCallback((files: File[]): string[] => {
    if (!files.length) return [];
    const { next, added, note: message } = addFiles(list.current, files, (file) => {
      const image = allow.images && isAttachableImage(file);
      return { key: `a${++counter.current}`, file, preview: image ? URL.createObjectURL(file) : "", kind: image ? "image" : "file", status: "uploading", progress: 0 };
    }, allow);
    list.current = next;
    setItems(next);
    setNote(message);
    for (const item of added) upload(item);
    return added.map((item) => item.key);
  }, [upload, allow.images, allow.files]);

  const remove = useCallback((key: string) => {
    const item = list.current.find((entry) => entry.key === key);
    if (!item) return;
    aborts.current.get(key)?.abort();
    if (item.uploadId && bootstrap) discardUpload(item.uploadId, bootstrap);
    if (item.preview) URL.revokeObjectURL(item.preview);
    setItems((old) => old.filter((entry) => entry.key !== key));
    setNote("");
  }, [bootstrap]);

  const retry = useCallback((key: string) => {
    const item = list.current.find((entry) => entry.key === key);
    if (item) upload(item);
  }, [upload]);

  /**
   * After a send is accepted: the attachments it CAPTURED (keys taken when
   * Send was pressed) leave the tray — their previews now belong to the
   * pending bubble. Anything added while it was sending stays for the next message.
   */
  const take = useCallback((keys: readonly string[]): Attachment[] => {
    const { taken, kept } = takeSent(list.current, keys);
    list.current = kept;
    setItems(kept);
    if (!kept.length) setNote("");
    return taken;
  }, []);

  useEffect(() => () => { for (const controller of aborts.current.values()) controller.abort(); }, []);
  return { items, note, add, remove, retry, take };
}
