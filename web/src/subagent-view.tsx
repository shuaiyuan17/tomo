import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { SubagentPage, TaskOutput, WebTask } from "../../src/web/protocol.js";
import { api, ApiError } from "./api.js";
import { Text } from "./markdown.js";
import { ModelBadge } from "./model-badge.js";
import { Button } from "@/components/ui/button";
import { Terminal } from "@/components/ai/terminal";
import { Tool, ToolContent, ToolHeader, ToolSection } from "@/components/ai/tool";
import { followStep, INITIAL_TRANSCRIPT, isOutputTask, POLL_MS, transcriptReducer, viewRows, type TranscriptAction } from "./subagent.js";
import { STATE_LABELS, taskKind } from "./tasks.js";

/**
 * While the task runs, poll for new lines every POLL_MS (`after=<end>` reads
 * only the bytes appended since). Polling, not task_progress: progress events
 * are sparse (only some task types, summaries are opt-in) and a byte-offset
 * tail costs one small read, works across SSE reconnects, and stops itself
 * when the task ends. See followStep in subagent.ts.
 */

type Status = "loading" | "ready" | "missing" | "error" | "gone";

/** Read-only view of one task: a subagent's transcript, or a shell's output tail. */
export function SubagentView({ task, onBack }: { task: WebTask; onBack: () => void }) {
  const base = `/sessions/${task.sessionId}/tasks/${encodeURIComponent(task.taskId)}`;
  const running = task.state === "running";
  return <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="subagent-heading">
    <div className="mb-2 flex items-start gap-1.5 pr-2.5">
      <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to tasks"
        className="h-8 shrink-0 gap-1 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground">
        <ArrowLeft className="size-4" strokeWidth={1.75} />Tasks</Button>
    </div>
    <div className="mb-3 px-2.5">
      <h2 id="subagent-heading" className="m-0 text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]">{task.description || "Untitled task"}<ModelBadge model={task.model} className="align-[2px]" /></h2>
      <p className="m-0 mt-0.5 font-mono text-[10px] text-muted-foreground">{taskKind(task)} · {running ? <span className="shimmer">Working</span> : STATE_LABELS[task.state]}</p>
    </div>
    {isOutputTask(task.taskType) ? <OutputTail base={base} running={running} /> : <Transcript base={base} running={running} />}
  </section>;
}

function OutputTail({ base, running }: { base: string; running: boolean }) {
  const [value, setValue] = useState<TaskOutput>();
  const [status, setStatus] = useState<Status>("loading");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      try { const next = await api<TaskOutput>(`${base}/output`, { signal: controller.signal }); if (!stopped) { setValue(next); setStatus("ready"); } }
      catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.code === "task_not_found") { setStatus("gone"); return; }
        setStatus(error instanceof ApiError && error.status === 404 ? "missing" : "error");
      }
      if (!stopped && running) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [base, running]);
  return <div className="min-h-0 flex-1 overflow-y-auto pr-2.5 pl-1">
    {status === "gone" && <Note status="gone" />}
    {value ? <Terminal output={value.output} size={value.size} /> : status !== "gone" && <Note status={status} />}
  </div>;
}

function Transcript({ base, running }: { base: string; running: boolean }) {
  const [state, dispatch] = useReducer(transcriptReducer, INITIAL_TRANSCRIPT);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const restore = useRef<number | null>(null);
  const fetchPage = useCallback((query: string, signal?: AbortSignal) => api<SubagentPage>(`${base}/transcript${query}`, { signal }), [base]);
  // Every action also updates the ref at once, so a follow step decides on
  // the page it just read (not on the last render's state).
  const apply = useCallback((action: TranscriptAction) => {
    stateRef.current = transcriptReducer(stateRef.current, action);
    dispatch(action);
  }, []);
  const classify = useCallback((error: unknown) =>
    // The daemon refuses a task that left the panel (expired, crowded out,
    // hidden): that is "gone" — stop, keep what was read.
    error instanceof ApiError && error.code === "task_not_found" ? "gone" as const
      : error instanceof ApiError && error.status === 409 ? "reset" as const
      : error instanceof ApiError && error.status === 404 ? "missing" as const : "error" as const, []);

  const { mode, gen, status } = state;
  const isGone = status === "gone";
  useEffect(() => {
    if (mode !== "follow" || isGone) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const loop = async () => {
      const delay = await followStep({ gen, running, get: () => stateRef.current,
        apply: (action) => { if (!stopped) apply(action); },
        fetchPage: (query) => fetchPage(query, controller.signal), classify });
      if (!stopped && delay !== null) timer = setTimeout(() => void loop(), delay);
    };
    void loop();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [fetchPage, apply, classify, running, mode, gen, isGone]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (restore.current !== null) { element.scrollTop = element.scrollHeight - restore.current; restore.current = null; }
    else if (pinned.current && state.mode === "follow") element.scrollTop = element.scrollHeight;
  }, [state]);

  const older = async () => {
    if (loadingOlder || !state.hasEarlier || state.status === "gone") return;
    // Leaving follow mode stops polling at once (new generation).
    if (stateRef.current.mode === "follow") apply({ type: "browse" });
    const { gen: browseGen, start } = stateRef.current;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(`?before=${start}`);
      const element = scroll.current;
      if (element) restore.current = element.scrollHeight - element.scrollTop;
      apply({ type: "older", gen: browseGen, page });
    } catch (error) {
      const kind = classify(error);
      apply({ type: "failed", gen: browseGen, kind: kind === "reset" ? "error" : kind });
    }
    finally { setLoadingOlder(false); }
  };
  const jump = () => { pinned.current = true; apply({ type: "jump" }); };

  const rows = viewRows(state.items);
  const gone = state.status === "gone";
  return <div ref={scroll} tabIndex={0} aria-label="Subagent transcript" onScroll={() => { const e = scroll.current!; pinned.current = e.scrollHeight - e.scrollTop - e.clientHeight < 40; }}
    className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-2.5 pl-1 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
    {gone && <p role="status" className="m-0 mb-2 rounded-lg bg-muted/70 px-2.5 py-2 text-[12px] text-muted-foreground">This task has left the panel, so nothing more can be loaded. What was read stays here.</p>}
    {!gone && state.hasEarlier && <Button variant="outline" size="sm" className="mx-auto mb-2 flex h-7 rounded-full text-[11px]" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? "Loading…" : "Load earlier"}</Button>}
    {(state.status === "loading" || state.status === "missing" || state.status === "error") && !state.items.length && <Note status={state.status} />}
    {state.status === "ready" && rows.length === 0 && <p className="m-0 px-1.5 text-[13px] text-muted-foreground">{running ? "Nothing yet." : "No recorded steps."}</p>}
    {rows.map((row) => row.kind === "text"
      ? <div key={row.id} className="markdown px-1.5 py-1 text-[13px]! leading-relaxed"><Text>{row.text + (row.truncated ? "\n\n…" : "")}</Text></div>
      : <Tool key={row.id}>
          <ToolHeader title={row.summary || row.name} state={row.result ? (row.result.isError ? "error" : "done") : running ? "running" : "done"} />
          <ToolContent>
            <ToolSection label="Input" text={row.input} truncated={row.inputTruncated} />
            {row.result && <ToolSection label={row.result.isError ? "Error" : "Output"} text={row.result.output} truncated={row.result.truncated} error={row.result.isError} />}
          </ToolContent>
        </Tool>)}
    {!gone && state.mode === "browse" && <Button variant="secondary" size="sm" onClick={jump}
      className="sticky bottom-1 mx-auto mt-2 flex h-7 rounded-full text-[11px] shadow-sm">↓ Jump to latest</Button>}
  </div>;
}

function Note({ status }: { status: Status }) {
  const text = status === "loading" ? "Opening…" : status === "missing" ? "Nothing recorded for this task yet."
    : status === "gone" ? "This task has left the panel, so nothing more can be loaded." : "This task can't be shown right now.";
  return <p className="m-0 px-1.5 text-[13px] text-muted-foreground" role="status">{text}</p>;
}
