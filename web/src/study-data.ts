import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

export const STUDY_PAGES = ["todos", "memory", "context", "cron", "mcp", "config"] as const;
export type StudyPage = typeof STUDY_PAGES[number];
export const STUDY_LABELS: Record<StudyPage, string> = { todos: "TODOs", memory: "Memory", context: "Context", cron: "Cron", mcp: "MCP servers", config: "Config" };

/** `#study/<page>`: the Study is linkable and the back button leaves it. */
export function viewFromHash(hash: string): StudyPage | null {
  const match = /^#study(?:\/([a-z]+))?$/.exec(hash);
  if (!match) return null;
  return (STUDY_PAGES as readonly string[]).includes(match[1] ?? "") ? match[1] as StudyPage : "todos";
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
  return sameDay ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) })
      + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatTokens(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : value.toLocaleString();
}

/** Open / done checkbox counts of a markdown task list. */
export function countTasks(markdown: string): { open: number; done: number } {
  let open = 0, done = 0;
  for (const line of markdown.split("\n")) {
    const match = /^\s*[-*+]\s+\[([ xX])\](?:\s|$)/.exec(line);
    if (match) { if (match[1] === " ") open++; else done++; }
  }
  return { open, done };
}
