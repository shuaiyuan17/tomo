import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { SubagentPage, TaskOutput, WebTask } from "../../src/web/protocol.js";
import { api, ApiError } from "./api.js";
import { Text } from "./markdown.js";
import { Button } from "@/components/ui/button";
import { Terminal } from "@/components/ai/terminal";
import { Tool, ToolContent, ToolHeader, ToolSection } from "@/components/ai/tool";
import { EMPTY_TRANSCRIPT, hasNewer, isOutputTask, mergePage, viewRows, type TranscriptState } from "./subagent.js";
import { STATE_LABELS, taskKind } from "./tasks.js";

/**
 * While the task runs, poll for new lines every POLL_MS (`after=<end>` reads
 * only the bytes appended since). Polling, not task_progress: progress events
 * are sparse (only some task types, summaries are opt-in) and a byte-offset
 * tail costs one small read, works across SSE reconnects, and stops itself
 * when the task ends.
 */
export const POLL_MS = 2_000;

type Status = "loading" | "ready" | "missing" | "error";

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
      <h2 id="subagent-heading" className="m-0 text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]">{task.description || "Untitled task"}</h2>
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
      catch (error) { if (!stopped) setStatus(error instanceof ApiError && error.status === 404 ? "missing" : "error"); }
      if (!stopped && running) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [base, running]);
  return <div className="min-h-0 flex-1 overflow-y-auto pr-2.5 pl-1">
    {value ? <Terminal output={value.output} size={value.size} /> : <Note status={status} />}
  </div>;
}

function Transcript({ base, running }: { base: string; running: boolean }) {
  const [state, setState] = useState<TranscriptState>(EMPTY_TRANSCRIPT);
  const [status, setStatus] = useState<Status>("loading");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const restore = useRef<number | null>(null);
  const fetchPage = useCallback((query: string, signal?: AbortSignal) => api<SubagentPage>(`${base}/transcript${query}`, { signal }), [base]);

  // Commit a new state synchronously too, so the loop below reads it at once.
  const commit = useCallback((next: TranscriptState) => { stateRef.current = next; setState(next); }, []);
  const [catchUp, setCatchUp] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const tail = async () => {
      const page = await fetchPage("", controller.signal);
      if (!stopped) { commit(mergePage(EMPTY_TRANSCRIPT, page, "tail")); setStatus("ready"); }
    };
    const poll = async () => {
      let progressed = false;
      try {
        if (stateRef.current.end === 0 && stateRef.current.size === 0) await tail();
        else {
          const before = stateRef.current.end;
          const page = await fetchPage(`?after=${before}`, controller.signal);
          if (!stopped) { commit(mergePage(stateRef.current, page, "newer")); progressed = stateRef.current.end > before; }
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 409) { await tail().catch(() => {}); }
        else if (error instanceof ApiError && error.status === 404) { if (stateRef.current.size === 0) setStatus("missing"); }
        else if (stateRef.current.size === 0) setStatus("error");
      }
      if (stopped) return;
      // Behind the file's end (a long backlog, or the end was rolled back to
      // free memory): keep reading straight away until caught up — also after
      // the task ended. While it runs, then poll for new lines.
      if (progressed && hasNewer(stateRef.current)) timer = setTimeout(() => void poll(), 0);
      else if (running) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [fetchPage, running, commit, catchUp]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (restore.current !== null) { element.scrollTop = element.scrollHeight - restore.current; restore.current = null; }
    else if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [state]);

  const older = async () => {
    if (loadingOlder || !state.hasEarlier) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(`?before=${state.start}`);
      const element = scroll.current;
      if (element) restore.current = element.scrollHeight - element.scrollTop;
      commit(mergePage(stateRef.current, page, "older"));
    } catch { /* The button stays; trying again is harmless. */ }
    finally { setLoadingOlder(false); }
  };

  const rows = viewRows(state.items);
  return <div ref={scroll} tabIndex={0} aria-label="Subagent transcript" onScroll={() => { const e = scroll.current!; pinned.current = e.scrollHeight - e.scrollTop - e.clientHeight < 40; }}
    className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-2.5 pl-1 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
    {state.hasEarlier && <Button variant="outline" size="sm" className="mx-auto mb-2 flex h-7 rounded-full text-[11px]" disabled={loadingOlder} onClick={() => void older()}>{loadingOlder ? "Loading…" : "Load earlier"}</Button>}
    {status !== "ready" && <Note status={status} />}
    {status === "ready" && rows.length === 0 && <p className="m-0 px-1.5 text-[13px] text-muted-foreground">{running ? "Nothing yet." : "No recorded steps."}</p>}
    {rows.map((row) => row.kind === "text"
      ? <div key={row.id} className="markdown px-1.5 py-1 text-[13px]! leading-relaxed"><Text>{row.text + (row.truncated ? "\n\n…" : "")}</Text></div>
      : <Tool key={row.id}>
          <ToolHeader title={row.summary || row.name} state={row.result ? (row.result.isError ? "error" : "done") : running ? "running" : "done"} />
          <ToolContent>
            <ToolSection label="Input" text={row.input} truncated={row.inputTruncated} />
            {row.result && <ToolSection label={row.result.isError ? "Error" : "Output"} text={row.result.output} truncated={row.result.truncated} error={row.result.isError} />}
          </ToolContent>
        </Tool>)}
    {status === "ready" && !running && hasNewer(state) && <Button variant="outline" size="sm" className="mx-auto mt-2 flex h-7 rounded-full text-[11px]"
      onClick={() => setCatchUp((n) => n + 1)}>Load newer</Button>}
  </div>;
}

function Note({ status }: { status: Status }) {
  const text = status === "loading" ? "Opening…" : status === "missing" ? "Nothing recorded for this task yet." : "This task can't be shown right now.";
  return <p className="m-0 px-1.5 text-[13px] text-muted-foreground" role="status">{text}</p>;
}
