import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { i18n } from "./i18n/index.js";
import { formatCompact, formatDate, formatNumber } from "./i18n/format.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: study:page.*

export const STUDY_PAGES = ["todos", "memory", "context", "model", "cost", "cron", "mcp", "config"] as const;
export type StudyPage = typeof STUDY_PAGES[number];
const STUDY_LABELS = {
  todos: "study:page.todos", memory: "study:page.memory", context: "study:page.context", model: "study:page.model",
  cost: "study:page.cost", cron: "study:page.cron", mcp: "study:page.mcp", config: "study:page.config",
} as const satisfies Record<StudyPage, string>;
/** A Study page's name in the active locale. */
export function studyLabel(page: StudyPage): string { return i18n.t(STUDY_LABELS[page]); }

/** `#study/<page>[/<item>]`: the Study is linkable and the back button leaves it. */
const STUDY_HASH = /^#study(?:\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,64}))?)?$/;
export function viewFromHash(hash: string): StudyPage | null {
  const match = STUDY_HASH.exec(hash);
  if (!match) return null;
  return (STUDY_PAGES as readonly string[]).includes(match[1] ?? "") ? match[1] as StudyPage : "todos";
}
/** The item a Study link points at (`#study/cron/<jobId>`), if any. */
export function focusFromHash(hash: string): string | null {
  const match = STUDY_HASH.exec(hash);
  return match && viewFromHash(hash) === match[1] ? match[2] ?? null : null;
}

/** The Study page the hash names (null: not in the Study), a way to go to one, and the item to focus. */
export function useStudyRoute(): [StudyPage | null, (page: StudyPage | null) => void, string | null] {
  const [page, setPage] = useState(() => viewFromHash(window.location.hash));
  const [focus, setFocus] = useState(() => focusFromHash(window.location.hash));
  useEffect(() => {
    const update = () => { setPage(viewFromHash(window.location.hash)); setFocus(focusFromHash(window.location.hash)); };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const go = (next: StudyPage | null) => {
    window.location.hash = next ? `study/${next}` : "";
    if (!next) history.replaceState(null, "", window.location.pathname + window.location.search);
    setPage(next); setFocus(null);
  };
  return [page, go, focus];
}
/** Link to one cron job in the Study's Cron tab. */
export function cronJobHash(id: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `#study/cron/${id}` : "#study/cron";
}

export type Resource<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; code: string };

/**
 * One GET, re-run when `path` or `reload` changes. The server serialises disk
 * inspections across clients (429 inspection_busy): that is retried a few
 * times rather than shown as an error.
 */
export function useResource<T>(path: string | null, reload = 0): [Resource<T>, () => void] {
  const [resource, setResource] = useState<Resource<T>>({ state: "loading" });
  const [local, setLocal] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResource((old) => old.state === "ready" ? old : { state: "loading" });
    const run = (attempt: number) => {
      api<T>(path, { signal: controller.signal }).then((value) => {
        if (!controller.signal.aborted) setResource({ state: "ready", value });
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.code === "inspection_busy" && attempt < 5) { timer = setTimeout(() => run(attempt + 1), 300 * (attempt + 1)); return; }
        setResource({ state: "error", code: error instanceof ApiError ? error.code : "unavailable" });
      });
    };
    run(0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, reload, local]);
  return [resource, useCallback(() => setLocal((value) => value + 1), [])];
}

export function formatWhen(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay ? formatDate(date, { hour: "2-digit", minute: "2-digit" })
    : formatDate(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

export function formatTokens(value: number): string {
  return value >= 10_000 ? formatCompact(value, value >= 100_000 ? 0 : 1) : formatNumber(value);
}
