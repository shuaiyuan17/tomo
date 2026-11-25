import { useCallback, useEffect, useRef, useState } from "react";
import type { WebBootstrap } from "./api.js";
import { ApiError, discardUpload, readStagedUpload, uploadImage } from "./api.js";
import type { WebFiledFile } from "../../src/web/protocol.js";
import { addFiles, filedAttachment, MAX_ATTACHMENTS, type KeptUpload, isAttachableImage, keptUploads, parseKeptUploads, replaceItems, restoredAttachment, takeSent, updateAttachment, type Attachment } from "./uploads.js";
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
  /** Where this tab keeps its finished uploads across a reload (see KeptUpload). */
  const storageKey = targetId ? `tomo-tray:${targetId}` : undefined;
  const kept = useRef(storageKey);
  kept.current = storageKey;
  /** Kept uploads a restore could not read back (a network error): still kept, for the next reload. */
  const unresolved = useRef<KeptUpload[]>([]);
  /** True while a reload's kept uploads are being read back: Send waits, or the message would go without them. */
  const [restoring, setRestoring] = useState(false);
  const commit = useCallback((change: (current: readonly Attachment[]) => Attachment[]) => {
    list.current = change(list.current);
    setItems(list.current);
    if (kept.current) {
      const keep = [...keptUploads(list.current), ...unresolved.current.filter((u) => !list.current.some((item) => item.uploadId === u.uploadId))];
      try { if (keep.length) sessionStorage.setItem(kept.current, JSON.stringify(keep)); else sessionStorage.removeItem(kept.current); }
      catch { /* Storage can be unavailable: the tray just does not survive a reload. */ }
    }
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

  /**
   * After a reload: the uploads this tab had finished come back into the
   * tray — each one the server still holds (unsent, unexpired), with its
   * thumbnail read back from there. One it no longer has is dropped.
   */
  const restored = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!storageKey || restored.current === storageKey) return;
    restored.current = storageKey;
    let wanted: ReturnType<typeof parseKeptUploads>;
    try { wanted = parseKeptUploads(sessionStorage.getItem(storageKey)); } catch { return; }
    if (!wanted.length) return;
    setRestoring(true);
    const failed: KeptUpload[] = [];
    // A few tries each: a 404 can be a claim that is about to be released (a send that failed),
    // and a network error is not an answer. What still errs stays kept; only a settled 404 drops it.
    const readBack = async (item: KeptUpload): Promise<Attachment | null> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const found = await readStagedUpload(item.uploadId);
          if (found) return found.kind === "image" ? restoredAttachment("", item, URL.createObjectURL(found.blob), found.blob.size)
            : restoredAttachment("", { ...item, kind: "file" }, "", found.size);
          if (attempt >= 2) return null;
        } catch {
          if (attempt >= 2) { failed.push(item); return null; }
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    };
    void Promise.all(wanted.map(readBack)).then((back) => {
      const items = back.filter((item): item is Attachment => !!item);
      if (kept.current === storageKey) unresolved.current = failed;
      // Another conversation by now (or a full tray): what did not go back stays staged until it expires.
      const fits = kept.current === storageKey ? items.filter((item) => !list.current.some((entry) => entry.uploadId === item.uploadId))
        .slice(0, Math.max(0, MAX_ATTACHMENTS - list.current.length)) : [];
      for (const item of items) if (!fits.includes(item) && item.preview) URL.revokeObjectURL(item.preview);
      // Committed even when nothing came back: storage then holds exactly what is still kept.
      if (kept.current === storageKey) commit((old) => [...fits.map((item) => ({ ...item, key: `a${++counter.current}` })), ...old]);
    }).finally(() => setRestoring(false));
  }, [storageKey, commit]);

  useEffect(() => () => { for (const controller of aborts.current.values()) controller.abort(); }, []);
  return { items, note, add, replaceAll, remove, retry, take, restoring };
}
