import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { HistoryMessage, HistoryPage } from "../../src/web/protocol.js";

export type HistoryStatus = "loading" | "loading-older" | "ready" | "error";
const EMPTY: HistoryPage = { messages: [], nextCursor: null };

/** The earlier copy of a message when nothing in it changed, so rows that read it can skip re-rendering. */
function keep(old: HistoryMessage | undefined, next: HistoryMessage): HistoryMessage {
  return old && JSON.stringify(old) === JSON.stringify(next) ? old : next;
}

/**
 * The latest page, read again (after a turn, an invalidation, a reconnect),
 * merged into what is loaded. A rewritten history (new revision) replaces it.
 * Messages that did not change keep their identity, and a read that changed
 * nothing returns `old` itself.
 */
export function mergeLatest(old: HistoryPage, page: HistoryPage): HistoryPage {
  if (old.revision !== page.revision) return page;
  const known = new Map(old.messages.map((m) => [m.id, m]));
  const fresh = page.messages.map((m) => keep(known.get(m.id), m));
  const ids = new Set(fresh.map((m) => m.id));
  const messages = [...old.messages.filter((m) => !ids.has(m.id)), ...fresh];
  // Older pages were loaded: their cursor still stands.
  const nextCursor = old.messages.length > 100 ? old.nextCursor : page.nextCursor;
  const same = nextCursor === old.nextCursor && messages.length === old.messages.length && messages.every((m, i) => m === old.messages[i]);
  return same ? old : { revision: page.revision, messages, nextCursor };
}

/** An older page ("Load earlier messages"), put in front of what is loaded. */
export function mergeOlder(old: HistoryPage, page: HistoryPage): HistoryPage {
  const known = new Set(old.messages.map((m) => m.id));
  return { revision: page.revision, messages: [...page.messages.filter((m) => !known.has(m.id)), ...old.messages], nextCursor: page.nextCursor };
}

/**
 * One conversation's recorded history: its latest page, read again whenever
 * `revision` (the event stream's invalidations) changes or `reload` is called,
 * and older pages on demand. Switching conversations starts afresh.
 */
export function useHistory(sessionId: string, revision: number) {
  const [history, setHistory] = useState<HistoryPage>(EMPTY);
  const [status, setStatus] = useState<HistoryStatus>("loading");
  const [reloads, setReloads] = useState(0);
  const loaded = useRef("");
  const reload = useCallback(() => setReloads((value) => value + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    if (loaded.current !== sessionId) {
      loaded.current = sessionId;
      setHistory(EMPTY); setStatus("loading");
    }
    void api<HistoryPage>(`/sessions/${sessionId}/messages`, { signal: controller.signal }).then((page) => {
      if (controller.signal.aborted) return;
      setHistory((old) => mergeLatest(old, page));
      setStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [sessionId, revision, reloads]);

  const loadOlder = async () => {
    if (!history.nextCursor || status === "loading-older") return;
    const target = sessionId;
    setStatus("loading-older");
    try {
      const page = await api<HistoryPage>(`/sessions/${target}/messages?cursor=${encodeURIComponent(history.nextCursor)}`);
      if (loaded.current !== target) return;
      setHistory((old) => mergeOlder(old, page));
      setStatus("ready");
    } catch (error) {
      if (loaded.current !== target) return;
      // The transcript rotated under the cursor: start again from the latest page.
      if (error instanceof ApiError && error.status === 409 && error.code === "history_changed") {
        setHistory(EMPTY); setStatus("loading");
        reload();
      } else setStatus("error");
    }
  };

  return { history, status, reload, loadOlder };
}
