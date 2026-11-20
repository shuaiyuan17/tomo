import { useCallback, useEffect, useRef, useState } from "react";
import type { WebBootstrap } from "./api.js";
import { ApiError, discardUpload, uploadImage } from "./api.js";
import type { WebFiledFile } from "../../src/web/protocol.js";
import { addFiles, filedAttachment, isAttachableImage, replaceItems, takeSent, updateAttachment, type Attachment } from "./uploads.js";
import { deferred, type Message } from "./i18n/message.js";

const failure = (error: unknown) => {
  if (!(error instanceof ApiError)) return deferred.t("chat:attach.failed");
  switch (error.code) {
    case "not_image": return deferred.t("chat:attach.error.notImage");
    case "too_large": return deferred.t("chat:attach.error.tooLarge");
    case "uploads_disabled": return deferred.t("chat:attach.error.disabled");
    case "epoch_changed": return deferred.t("chat:attach.error.restarted");
    case "upload_limit": return deferred.t("chat:attach.error.limit");
    default: return deferred.t("chat:attach.failed");
  }
};

/**
 * The composer's attachment tray: each file uploads as soon as it is added;
 * failed ones can be retried. `allow`: which kinds the daemon keeps (bootstrap capabilities).
 */
export function useAttachments(bootstrap: WebBootstrap | undefined, refresh: () => Promise<WebBootstrap>, targetId: string | undefined,
  allow: { images: boolean; files: boolean } = { images: true, files: false }) {
  const [items, setItems] = useState<Attachment[]>([]);
  /** Why some files were not added, worded when shown (see noteText). */
  const [note, setNote] = useState<Message[]>([]);
  /**
   * The ONE source of truth for the tray. Every change goes through `commit`,
   * which updates it synchronously and only then schedules the render, so two
   * changes in one tick (remove then add, a send's take then a paste) each
   * see the other. React state is only its rendered copy.
   */
  const list = useRef<Attachment[]>([]);
  const commit = useCallback((change: (current: readonly Attachment[]) => Attachment[]) => {
    list.current = change(list.current);
    setItems(list.current);
  }, []);
  const aborts = useRef(new Map<string, AbortController>());
  const counter = useRef(0);

  /** An item leaving the tray: its upload stops, its staged copy and preview go. */
  const release = useCallback((item: Attachment) => {
    aborts.current.get(item.key)?.abort();
    if (item.uploadId && bootstrap) discardUpload(item.uploadId, bootstrap);
    if (item.preview) URL.revokeObjectURL(item.preview);
  }, [bootstrap]);

  const upload = useCallback((item: Attachment) => {
    if (!bootstrap || !targetId) { commit((old) => updateAttachment(old, item.key, { status: "failed", error: deferred.t("chat:attach.error.offline") })); return; }
    const controller = new AbortController();
    aborts.current.set(item.key, controller);
    commit((old) => updateAttachment(old, item.key, { status: "uploading", progress: 0, error: undefined }));
    uploadImage(item.file, targetId, bootstrap, refresh, (progress) => commit((old) => updateAttachment(old, item.key, { progress })), controller.signal)
      .then((value) => {
        if (!list.current.some((entry) => entry.key === item.key)) { discardUpload(value.uploadId, bootstrap); return; }
        // The server decides what it is by its bytes: a file the browser called an image may come back a plain file.
        const kind = value.kind ?? "image";
        if (kind === "file" && item.preview) URL.revokeObjectURL(item.preview);
        commit((old) => updateAttachment(old, item.key, { status: "done", progress: 1, uploadId: value.uploadId, kind, ...(kind === "file" ? { preview: "" } : {}) }));
      }, (error) => {
        if (controller.signal.aborted) return;
        commit((old) => updateAttachment(old, item.key, { status: "failed", error: failure(error) }));
      })
      .finally(() => aborts.current.delete(item.key));
  }, [bootstrap, refresh, targetId, commit]);

  /** Returns the keys of the attachments added. */
  const add = useCallback((files: File[]): string[] => {
    if (!files.length) return [];
    const { next, added, note: message } = addFiles(list.current, files, (file) => {
      const image = allow.images && isAttachableImage(file);
      return { key: `a${++counter.current}`, file, preview: image ? URL.createObjectURL(file) : "", kind: image ? "image" : "file", status: "uploading", progress: 0 };
    }, allow);
    commit(() => next);
    setNote(message);
    for (const item of added) upload(item);
    return added.map((item) => item.key);
  }, [upload, commit, allow.images, allow.files]);

  /**
   * Resend, atomically: the items in `dropKeys` (the previous resend's) leave
   * and `filed` (this one's already-filed files) come in — one change, so
   * nothing removed can come back and nothing added can be lost. Returns the
   * new items' keys.
   */
  const replaceAll = useCallback((dropKeys: readonly string[], filed: readonly WebFiledFile[]): string[] => {
    const added = filed.map((file) => filedAttachment(`a${++counter.current}`, file));
    const { next, dropped } = replaceItems(list.current, dropKeys, added);
    for (const item of dropped) release(item);
    commit(() => next);
    if (dropped.length) setNote([]);
    return added.map((item) => item.key);
  }, [commit, release]);

  const remove = useCallback((key: string) => {
    const item = list.current.find((entry) => entry.key === key);
    if (!item) return;
    release(item);
    commit((old) => old.filter((entry) => entry.key !== key));
    setNote([]);
  }, [commit, release]);

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
    commit(() => kept);
    if (!kept.length) setNote([]);
    return taken;
  }, [commit]);

  useEffect(() => () => { for (const controller of aborts.current.values()) controller.abort(); }, []);
  return { items, note, add, replaceAll, remove, retry, take };
}
