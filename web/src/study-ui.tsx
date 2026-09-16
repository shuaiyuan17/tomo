import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import type { SafeField } from "../../src/web/management.js";

export function failure(error: unknown): string {
  if (!(error instanceof ApiError)) return "The connection was interrupted. Reload to check the result before trying again.";
  const messages: Record<string, string> = {
    config_changed: "Config changed elsewhere. Reload and review your changes again.", cron_changed: "This task changed while you were reviewing it. Reload and confirm again.",
    invalid_config: "Some settings are invalid. Check the listed fields before previewing again.", preview_expired: "This preview expired or belongs to another browser. Create a fresh preview.",
    unschedulable: "This schedule has no future occurrence. It was left unchanged.", epoch_changed: "Tomo restarted. Reload before making changes.",
    memory_invalid_path: "This file is outside the readable memory directory.", memory_limit: "This file exceeds the 256 KiB viewer limit.",
    memory_not_found: "This memory file no longer exists.", memory_unavailable: "Memory is unavailable. Check the workspace permissions.",
  };
  return error.status === 401 ? "Open the private access link to reconnect." : messages[error.code] ?? "This operation could not be completed. Reload and try again.";
}
export function useResource<T>(path: string, version: number) {
  const [value, setValue] = useState<T>(); const [error, setError] = useState(""); const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void api<T>(path, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setValue(data); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(failure(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, version, refresh]);
  return { value, error, loading, reload: () => setRefresh((r) => r + 1) };
}
export function ResourceState({ loading, error, retry }: { loading: boolean; error: string; retry(): void }) {
  return error ? <div className="notice" role="alert">{error} <button onClick={retry}>Reload</button></div> : loading ? <p className="empty-note" role="status">Loading…</p> : null;
}
export function Dialog({ title, children, cancel, confirm, action = "Confirm", busy = false }: { title: string; children: ReactNode; cancel(): void; confirm(): void; action?: string; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; const previous = document.activeElement as HTMLElement | null; dialog.showModal(); return () => { dialog.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} className="review-dialog" aria-labelledby="dialog-title" onCancel={(e) => { e.preventDefault(); if (!busy) cancel(); }}>
    <h2 id="dialog-title">{title}</h2><div className="dialog-content">{children}</div><div className="dialog-actions"><button autoFocus disabled={busy} onClick={cancel}>Cancel</button><button className="primary" disabled={busy} onClick={confirm}>{busy ? "Working…" : action}</button></div>
  </dialog>;
}
export const when = (value: number | string | null | undefined): string => value ? new Date(value).toLocaleString() : "—";
export function FieldEditor({ field, draft, change }: { field: SafeField; draft: string | undefined; change(value: string): void }) {
  const label = field.label; const id = `field-${field.path.join("-")}`;
  const current = field.secret ? "" : field.kind === "json" ? field.value === undefined ? "" : JSON.stringify(field.value, null, 2) : String(field.value ?? "");
  const value = draft ?? (field.kind === "boolean" && current ? ["true", "1", "yes", "on"].includes(current.trim().toLowerCase()) ? "true" : "false" : current);
  return <div className="config-field"><div className="field-heading"><label htmlFor={id}>{label}</label><span className="scope">{field.secret ? field.set ? "Set" : "Unset" : field.set ? "Saved" : "Default"}</span></div>
    {field.kind === "json" ? <textarea id={id} rows={3} value={value} placeholder={field.secret ? "Enter replacement JSON; leave unchanged to preserve" : "JSON value"} spellCheck={false} onChange={(e) => change(e.target.value)} />
      : field.kind === "boolean" || field.options ? <select id={id} value={value} onChange={(e) => change(e.target.value)}><option value="">Use default</option>{(field.options ?? ["true", "false"]).map((option) => <option key={option} value={option}>{option}</option>)}</select>
      : <input id={id} type={field.secret ? "password" : field.kind === "number" ? "number" : "text"} autoComplete="off" value={value} placeholder={field.secret ? "Replace value" : "Use default"} onChange={(e) => change(e.target.value)} />}
    {field.secret && <small>{field.runningSet !== undefined && <>Running: {field.runningSet ? "Set" : "Unset"}. </>}Existing values stay hidden. Only a replacement is submitted.</small>}
    {field.overridden && <small>Environment override: {field.env}. Saving does not replace it.</small>}
    {!field.secret && field.running !== undefined && <small>Running: <code>{typeof field.running === "object" ? JSON.stringify(field.running) : String(field.running)}</code></small>}
  </div>;
}
export function fieldInput(field: SafeField, text: string): unknown {
  if (field.kind === "json") return JSON.parse(text);
  if (field.kind === "boolean") return text === "true";
  if (field.kind === "number") { if (!text.trim() || !Number.isFinite(Number(text))) throw new Error("Invalid number"); return Number(text); }
  return text;
}
