import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, FileText, Folder, Lock, RefreshCw, Search, X } from "lucide-react";
import type { WebConfigField, WebConfigView, WebContext, WebCronJob, WebMcpView, WebMemoryFile, WebMemorySearch,
  WebMemoryTree, WebSession, WebTodos } from "../../src/web/protocol.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Text } from "./markdown.js";
import { countTasks, formatTokens, formatWhen, STUDY_LABELS, STUDY_PAGES, useResource, type Resource, type StudyPage } from "./study-data.js";

const INTRO: Record<StudyPage, string> = {
  todos: "Task lists Tomo keeps in memory/TODO*.md. Read-only here.",
  memory: "What Tomo remembers, as it is written in the workspace. Private memory is never shown in the browser.",
  context: "How full the selected conversation's context window is, and what has been rolled up.",
  cron: "Scheduled jobs and when they last ran.",
  mcp: "External tool servers in config.json, and what live sessions report about them.",
  config: "The saved config.json. Secrets appear only as set or not set.",
};

const card = "rounded-xl border bg-card shadow-xs";
const meta = "font-mono text-[11px] text-muted-foreground";

const ERRORS: Record<string, string> = {
  memory_not_found: "That file is not available.", memory_limit: "That file is too large to show here.",
  memory_invalid_path: "That path cannot be opened.", cron_unavailable: "The cron store could not be read.",
  config_invalid: "config.json is not valid JSON.", config_unavailable: "config.json could not be read.",
  session_not_found: "That conversation is no longer available.", request_limit: "Busy — try again in a moment.",
};

function Status({ resource, empty, children }: { resource: Resource<unknown>; empty?: ReactNode; children?: ReactNode }) {
  if (resource.state === "loading") return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (resource.state === "error") return <div className={cn(card, "px-4 py-3 text-[13px]")} role="alert">{ERRORS[resource.code] ?? "Unavailable right now."}</div>;
  return <>{empty ?? children}</>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={cn(card, "px-5 py-8 text-center text-sm text-muted-foreground")}>{children}</div>;
}

export function Study({ page, onPage, session, reload, inert }: { page: StudyPage; onPage: (page: StudyPage) => void; session?: WebSession; reload: number; inert?: boolean }) {
  const [local, setLocal] = useState(0);
  const key = reload + local;
  return <main id="study" tabIndex={-1} inert={inert} className="mx-auto flex min-h-0 w-full max-w-[1040px] min-w-0 flex-1 flex-col px-12 pt-7 max-[1024px]:px-7 max-[800px]:px-5 max-[600px]:px-4 max-[600px]:pt-4">
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0"><p className="eyebrow">The Study</p>
        <h1 className="mt-1 mb-1 font-serif text-[30px] leading-tight font-normal tracking-[-0.5px] max-[600px]:text-[24px]">{STUDY_LABELS[page]}</h1>
        <p className="m-0 text-[13px] text-muted-foreground">{INTRO[page]}</p></div>
      <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-xl text-muted-foreground hover:bg-foreground/[0.07]" aria-label="Refresh" title="Refresh" onClick={() => setLocal((v) => v + 1)}><RefreshCw strokeWidth={1.75} /></Button>
    </div>
    <Tabs value={page} onValueChange={(value) => onPage(value as StudyPage)} className="min-h-0 flex-1 gap-0">
      <TabsList aria-label="Study sections" className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-0 [scrollbar-width:none]">
        {STUDY_PAGES.map((value) => <TabsTrigger key={value} value={value}
          className="-mb-px h-10 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent! px-3 text-[13px] font-medium text-muted-foreground shadow-none! hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground dark:data-[state=active]:border-primary">{STUDY_LABELS[value]}</TabsTrigger>)}
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto pt-6 pb-10 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]" role="tabpanel" aria-label={STUDY_LABELS[page]}>
        {page === "todos" && <Todos reload={key} />}
        {page === "memory" && <Memory reload={key} />}
        {page === "context" && <Context session={session} reload={key} />}
        {page === "cron" && <Cron reload={key} />}
        {page === "mcp" && <Mcp reload={key} />}
        {page === "config" && <Config reload={key} />}
      </div>
    </Tabs>
  </main>;
}

function Todos({ reload }: { reload: number }) {
  const [resource] = useResource<WebTodos>("/todos", reload);
  const value = resource.state === "ready" ? resource.value : undefined;
  return <Status resource={resource} empty={value && (value.missing ? <Empty>The workspace has no memory folder yet.</Empty>
    : !value.files.length ? <Empty>No <code className="font-mono">memory/TODO*.md</code> files yet.</Empty> : undefined)}>
    <div className="space-y-4">{value?.files.map((file) => "error" in file
      ? <div key={file.path} className={cn(card, "px-5 py-4 text-[13px]")}><span className="font-mono">{file.path}</span> — {ERRORS[`memory_${file.error}`] ?? "unreadable"}</div>
      : <TodoFile key={file.path} file={file} />)}
      {value?.truncated && <p className={meta}>Only the first 32 TODO files are shown.</p>}</div>
  </Status>;
}

function TodoFile({ file }: { file: WebMemoryFile }) {
  const { open, done } = countTasks(file.content);
  return <section className={cn(card, "px-6 py-5")} aria-label={file.path}>
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="m-0 font-mono text-[13px] font-medium">{file.path}</h2>
      <span className={meta}>{open} open · {done} done</span>
      <span className={cn(meta, "ml-auto")}>Updated {formatWhen(file.modifiedAt)}</span></div>
    <div className="markdown [&_li:has(>input:checked)]:text-muted-foreground [&_li:has(>input:checked)]:line-through"><Text>{file.content}</Text></div>
  </section>;
}

function Memory({ reload }: { reload: number }) {
  const [tree] = useResource<WebMemoryTree>("/memory/tree", reload);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [file] = useResource<WebMemoryFile>(selected ? `/memory/file?path=${encodeURIComponent(selected)}` : null, reload);
  const [search] = useResource<WebMemorySearch>(query ? `/memory/search?q=${encodeURIComponent(query)}` : null, reload);
  const entries = tree.state === "ready" ? tree.value.entries : [];
  useEffect(() => {
    if (!selected && entries.some((e) => e.path === "MEMORY.md")) setSelected("MEMORY.md");
  }, [entries, selected]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visible = entries.filter((entry) => !entry.path.split("/").slice(0, -1).some((_, i, parts) => collapsed.has(parts.slice(0, i + 1).join("/"))));
  const submit = (event: FormEvent) => { event.preventDefault(); setQuery(draft.trim()); };
  if (tree.state === "ready" && tree.value.missing) return <Empty>The workspace has no memory folder yet.</Empty>;
  return <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-6 max-[900px]:grid-cols-1">
    <div className="flex min-w-0 flex-col gap-3">
      <form onSubmit={submit} role="search" className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
        <label htmlFor="memory-search" className="sr-only">Search memory</label>
        <Input id="memory-search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search memory" maxLength={200}
          className="h-10 rounded-xl bg-card pr-9 pl-9 text-[13px] md:text-[13px]" />
        {query && <Button type="button" variant="ghost" size="icon" aria-label="Clear search" onClick={() => { setDraft(""); setQuery(""); }}
          className="absolute top-1/2 right-1 size-8 -translate-y-1/2 rounded-lg text-muted-foreground"><X /></Button>}
      </form>
      <div className={cn(card, "min-h-0 overflow-hidden")}>
        <ScrollArea className="h-[min(560px,calc(100dvh-340px))] max-[900px]:h-64">
          <div className="p-2">
            {query ? <Status resource={search} empty={search.state === "ready" && !search.value.results.length ? <p className="m-2 text-[13px] text-muted-foreground">No matches.</p> : undefined}>
              <ul className="m-0 list-none space-y-0.5 p-0">{search.state === "ready" && search.value.results.map((hit, i) =>
                <li key={`${hit.path}:${hit.line}:${i}`}><button type="button" onClick={() => setSelected(hit.path)}
                  className={cn("block w-full rounded-lg px-2.5 py-2 text-left hover:bg-foreground/[0.06]", selected === hit.path && "bg-foreground/[0.06]")}>
                  <span className={cn(meta, "block")}>{hit.path}:{hit.line}</span>
                  <span className="block truncate text-[13px]">{hit.text}</span></button></li>)}</ul>
              {search.state === "ready" && search.value.truncated && <p className={cn(meta, "m-2")}>Showing the first matches only.</p>}
            </Status>
              : <Status resource={tree}><ul className="m-0 list-none p-0">{visible.map((entry) => {
                const depth = entry.path.split("/").length - 1;
                const name = entry.path.split("/").at(-1)!;
                const isOpen = !collapsed.has(entry.path);
                return <li key={entry.path}><button type="button" style={{ paddingLeft: 10 + depth * 14 }}
                  aria-expanded={entry.kind === "directory" ? isOpen : undefined} aria-current={selected === entry.path ? "true" : undefined}
                  onClick={() => entry.kind === "file" ? setSelected(entry.path) : setCollapsed((old) => { const next = new Set(old); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })}
                  className={cn("flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[13px] hover:bg-foreground/[0.06]", selected === entry.path && "bg-foreground/[0.08] font-medium")}>
                  {entry.kind === "directory" ? <><ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} /><Folder className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} /></>
                    : <FileText className="ml-5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
                  <span className="truncate">{name}</span></button></li>;
              })}</ul>
              {tree.state === "ready" && tree.value.truncated && <p className={cn(meta, "m-2")}>The tree is large; only part of it is listed.</p>}</Status>}
          </div>
        </ScrollArea>
      </div>
    </div>
    <div className="min-w-0">
      {!selected ? <Empty>Choose a file to read it.</Empty> : <Status resource={file}>
        {file.state === "ready" && <article className={cn(card, "px-7 py-6 max-[600px]:px-5")} aria-label={file.value.path}>
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-3">
            <h2 className="m-0 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{file.value.path}</h2>
            <span className={cn(meta, "ml-auto")}>Updated {formatWhen(file.value.modifiedAt)}</span></div>
          {file.value.hiddenLines > 0 && <p className={cn(meta, "mt-0 mb-3 flex items-center gap-1.5")}><Lock className="size-3" />{file.value.hiddenLines} {file.value.hiddenLines === 1 ? "line links" : "lines link"} to private memory and {file.value.hiddenLines === 1 ? "is" : "are"} not shown.</p>}
          <div className="markdown"><Text>{file.value.content}</Text></div>
        </article>}
      </Status>}
    </div>
  </div>;
}

/** `Read:14` (the estimator's tool:count) as `Read ×14`. */
function toolList(tools: string[], limit: number): string {
  return tools.slice(0, limit).map((tool) => tool.replace(/:(\d+)$/, " ×$1")).join(", ") + (tools.length > limit ? ", …" : "");
}

function Meter({ used, max }: { used: number; max: number }) {
  return <Progress max={max} value={Math.min(used, max)} aria-label="Context tokens used" className="h-1.5 bg-border" />;
}

function Context({ session, reload }: { session?: WebSession; reload: number }) {
  const [resource] = useResource<WebContext>(session ? `/sessions/${session.id}/context` : null, reload);
  if (!session) return <Empty>Choose a conversation in the sidebar.</Empty>;
  const value = resource.state === "ready" ? resource.value : undefined;
  const sections = value?.analysis ? [...value.analysis.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 12) : [];
  const breakdownTotal = value?.breakdown.reduce((sum, item) => sum + item.tokens, 0) ?? 0;
  return <Status resource={resource}>{value && <div className="space-y-5">
    <section className={cn(card, "px-6 py-5")} aria-labelledby="ctx-window">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="eyebrow" id="ctx-window">Context window · {session.title}</p>
        <span className={meta}>{value.recordedAt ? `Last recorded ${formatWhen(value.recordedAt)}` : "No turn recorded yet"}</span></div>
      {value.max ? <>
        <p className="mt-2 mb-3 font-mono text-2xl">{value.used!.toLocaleString()} <span className="text-sm text-muted-foreground">/ {value.max.toLocaleString()} · {Math.round(value.used! / value.max * 100)}%</span></p>
        <Meter used={value.used!} max={value.max} />
        <p className="mt-3 mb-0 text-[13px] text-muted-foreground">{value.estimated ? "Estimated" : "Reported by the model"} at the end of the last turn.</p>
      </> : <p className="mt-2 mb-0 text-sm text-muted-foreground">Unavailable until a turn reports its context window.</p>}
      {value.breakdown.length > 0 && <ul className="mt-5 mb-0 list-none space-y-2 p-0">{value.breakdown.map((item) =>
        <li key={item.name} className="grid grid-cols-[minmax(0,1fr)_80px] items-center gap-3 text-[13px]">
          <div className="min-w-0"><div className="flex justify-between gap-2"><span className="truncate">{item.name}</span></div>
            <div className="mt-1 h-1 rounded-full bg-border"><div className="h-1 rounded-full bg-primary/70" style={{ width: `${breakdownTotal ? item.tokens / breakdownTotal * 100 : 0}%` }} /></div></div>
          <span className="text-right font-mono text-xs text-muted-foreground">{formatTokens(item.tokens)}</span></li>)}</ul>}
    </section>

    <section className={cn(card, "px-6 py-5")} aria-labelledby="ctx-sections">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2"><p className="eyebrow" id="ctx-sections">Largest stretches of the transcript</p>
        {value.analysis && <span className={meta}>{value.analysis.totalMessages.toLocaleString()} messages · ≈{formatTokens(value.analysis.totalTokens)} tokens (estimate)</span>}</div>
      {value.analysisStatus === "too_large" ? <p className="m-0 text-[13px] text-muted-foreground">The transcript is too large to analyse here. Use <code className="font-mono">tomo lcm stats</code>.</p>
        : !value.analysis ? <p className="m-0 text-[13px] text-muted-foreground">No transcript to analyse yet.</p>
        : <ul className="m-0 list-none divide-y p-0">{sections.map((section) =>
          <li key={section.id} className="grid grid-cols-[48px_minmax(0,1fr)_72px] items-baseline gap-3 py-2 text-[13px]">
            <span className={meta}>#{section.id}</span>
            <span className="min-w-0"><span className="block truncate">{section.type === "conversation" ? "Conversation" : section.type === "tool_ops" ? `Tools: ${toolList(section.toolsUsed, 4)}` : `Conversation and tools: ${toolList(section.toolsUsed, 3)}`}</span>
              <span className={meta}>{section.messageCount} messages{section.toolCallCount ? ` · ${section.toolCallCount} tool calls` : ""} · {formatWhen(Date.parse(section.earliestAt))}</span></span>
            <span className="text-right font-mono text-xs">{formatTokens(section.tokens)}</span></li>)}</ul>}
    </section>

    <section className={cn(card, "px-6 py-5")} aria-labelledby="ctx-rollups">
      <p className="eyebrow mb-3" id="ctx-rollups">Rollups</p>
      {!value.summaries.length ? <p className="m-0 text-[13px] text-muted-foreground">No summary blocks in this session yet.</p>
        : <ul className="m-0 list-none space-y-1 p-0">{value.summaries.map((block, i) => <li key={`${block.tag}:${block.timestamp}:${i}`}>
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-foreground/[0.05]">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <Badge variant="outline" className="rounded-md font-mono text-[10px] font-normal">{block.level}</Badge>
              <span className="min-w-0 flex-1 truncate">{block.tag === "legacy" ? "Compact summary" : block.tag}</span>
              <span className={meta}>{block.eventsSummarized ? `${block.eventsSummarized} events · ` : ""}{block.timestamp ? formatWhen(Date.parse(block.timestamp)) : ""}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="px-9 pt-1 pb-3"><div className="markdown text-[14px]"><Text>{block.content}</Text></div>
              {block.truncated && <p className={meta}>Preview shortened.</p>}</CollapsibleContent>
          </Collapsible></li>)}</ul>}
      {value.summariesTruncated && <p className={cn(meta, "mt-2 mb-0")}>Only the 100 most recent blocks are listed.</p>}
      {!!value.recentCompactions?.length && <>
        <p className="eyebrow mt-5 mb-2">Compactions since Tomo started</p>
        <ul className="m-0 list-none space-y-1 p-0">{value.recentCompactions.slice().reverse().map((c, i) => <li key={i} className="flex justify-between gap-3 text-[13px]">
          <span>{formatWhen(c.timestamp)}</span>
          <span className="font-mono text-xs text-muted-foreground">{c.preTokens !== undefined ? formatTokens(c.preTokens) : "?"} → {c.postTokens !== undefined ? formatTokens(c.postTokens) : "?"}</span></li>)}</ul></>}
    </section>
  </div>}</Status>;
}

export function cronStatus(job: WebCronJob): { label: string; tone: "ok" | "warn" | "muted" } {
  if (job.interruptedAt) return { label: "Interrupted", tone: "warn" };
  if (job.lastStatus === "error") return { label: "Last run failed", tone: "warn" };
  if (job.lastStatus === "ok") return { label: "Last run ok", tone: "ok" };
  return { label: "Not run yet", tone: "muted" };
}

export function CronJobRow({ job, actions }: { job: WebCronJob; actions?: ReactNode }) {
  const status = cronStatus(job);
  return <li className={cn(card, "px-5 py-4", !job.enabled && "opacity-75")}>
    <Collapsible>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h2 className="m-0 text-[15px] font-medium">{job.name}</h2>
            <Badge variant={job.enabled ? "secondary" : "outline"} className="rounded-md font-mono text-[10px] font-normal">{job.enabled ? "Enabled" : "Paused"}</Badge>
            {job.deleteAfterRun && <Badge variant="outline" className="rounded-md font-mono text-[10px] font-normal">One-shot</Badge>}</div>
          <p className={cn(meta, "mt-1 mb-0")}>{job.scheduleLabel} · {job.sessionKey}</p>
        </div>
        {actions}
      </div>
      <dl className="mt-3 mb-0 grid grid-cols-3 gap-3 text-[13px] max-[600px]:grid-cols-1">
        <div><dt className={meta}>Next run</dt><dd className="m-0">{job.enabled ? formatWhen(job.nextRunAt) : "—"}</dd></div>
        <div><dt className={meta}>Last run</dt><dd className="m-0">{formatWhen(job.lastRunAt)}</dd></div>
        <div><dt className={meta}>Status</dt><dd className={cn("m-0", status.tone === "warn" && "text-destructive")}>{status.label}</dd></div>
      </dl>
      <CollapsibleTrigger className="group mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />Message</CollapsibleTrigger>
      <CollapsibleContent><p className="mt-2 mb-0 rounded-lg bg-muted px-4 py-3 text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{job.message}</p></CollapsibleContent>
    </Collapsible>
  </li>;
}

export function CronList({ jobs, actions }: { jobs: WebCronJob[]; actions?: (job: WebCronJob) => ReactNode }) {
  const sorted = useMemo(() => [...jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)), [jobs]);
  if (!jobs.length) return <Empty>No scheduled jobs.</Empty>;
  return <ul className="m-0 list-none space-y-3 p-0">{sorted.map((job) => <CronJobRow key={job.id} job={job} actions={actions?.(job)} />)}</ul>;
}

function Cron({ reload }: { reload: number }) {
  const [resource] = useResource<{ jobs: WebCronJob[] }>("/cron", reload);
  return <Status resource={resource}>{resource.state === "ready" && <CronList jobs={resource.value.jobs} />}</Status>;
}

const MCP_TONE: Record<string, string> = { connected: "bg-primary", failed: "bg-destructive", "needs-auth": "bg-destructive/70", pending: "bg-muted-foreground", disabled: "bg-border" };

function Mcp({ reload }: { reload: number }) {
  const [resource] = useResource<WebMcpView>("/mcp", reload);
  const value = resource.state === "ready" ? resource.value : undefined;
  return <Status resource={resource} empty={value && !value.servers.length ? <Empty>No external MCP servers in config.json.</Empty> : undefined}>
    {value && <>
      {!value.live.available && <p className={cn(meta, "mt-0 mb-3")}>Live connection status is unavailable right now.</p>}
      <ul className="m-0 list-none space-y-3 p-0">{value.servers.map((server) => {
        const live = value.live.sessions.flatMap((s) => (s.connections ?? []).filter((c) => c.name === server.name).map((c) => ({ sessionId: s.sessionId, status: c.status })));
        return <li key={server.name} className={cn(card, "px-5 py-4", !server.enabled && "opacity-75")}>
          <div className="flex flex-wrap items-center gap-2"><h2 className="m-0 font-mono text-[14px] font-medium">{server.name}</h2>
            <Badge variant="outline" className="rounded-md font-mono text-[10px] font-normal">{server.type}</Badge>
            <Badge variant={server.enabled ? "secondary" : "outline"} className="rounded-md font-mono text-[10px] font-normal">{server.enabled ? "Enabled" : "Disabled"}</Badge>
            {server.oauth && <Badge variant="outline" className="rounded-md font-mono text-[10px] font-normal">OAuth</Badge>}
            {server.alwaysLoad && <Badge variant="outline" className="rounded-md font-mono text-[10px] font-normal">Always loaded</Badge>}</div>
          <p className={cn(meta, "mt-1.5 mb-0 flex flex-wrap items-center gap-x-1.5")}>
            {server.configured.length ? <><Lock className="size-3" />{server.configured.join(" · ")} set</> : "No connection settings"}
            {server.timeout !== null && <> · timeout {server.timeout}s</>}</p>
          <div className="mt-3 text-[13px]">{!server.enabled ? <span className="text-muted-foreground">Not loaded while disabled.</span>
            : !live.length ? <span className="text-muted-foreground">{value.live.available ? "No live session reports it yet." : "Status unknown."}</span>
            : <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">{live.map((item) => <li key={item.sessionId} className="flex items-center gap-1.5">
              <i className={cn("size-1.5 rounded-full", MCP_TONE[item.status])} /><span>{item.status === "needs-auth" ? "Needs sign-in" : item.status[0].toUpperCase() + item.status.slice(1)}</span>
              <span className={meta}>{item.sessionId === live[0].sessionId && live.length === 1 ? "" : item.sessionId.slice(0, 6)}</span></li>)}</ul>}</div>
        </li>;
      })}</ul></>}
  </Status>;
}

function formatValue(field: WebConfigField): ReactNode {
  if (field.secret) return <span className="flex items-center gap-1.5 text-muted-foreground"><Lock className="size-3" />{field.set ? "Set" : "Not set"}</span>;
  const value = field.value;
  if (value === undefined || value === null || value === "") return <span className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) return value.length ? <span className="font-mono text-xs [overflow-wrap:anywhere]">{value.map(String).join(", ")}</span> : <span className="text-muted-foreground">empty</span>;
  if (typeof value === "object") return <span className="text-muted-foreground">empty</span>;
  return <span className="font-mono text-xs [overflow-wrap:anywhere]">{String(value)}</span>;
}

function Config({ reload }: { reload: number }) {
  const [resource] = useResource<WebConfigView>("/config", reload);
  const value = resource.state === "ready" ? resource.value : undefined;
  const groups = useMemo(() => {
    const map = new Map<string, WebConfigField[]>();
    for (const field of value?.fields ?? []) {
      const group = field.path.length > 1 ? field.path[0] : "general";
      map.set(group, [...(map.get(group) ?? []), field]);
    }
    return [...map].sort(([a], [b]) => a === "general" ? -1 : b === "general" ? 1 : a.localeCompare(b));
  }, [value]);
  return <Status resource={resource} empty={value?.missing ? <Empty>No config.json yet.</Empty> : undefined}>
    {value && <>
      <p className={cn(meta, "mt-0 mb-4")}>Read-only · saved {formatWhen(value.modifiedAt)} · values the daemon is running with may differ until it restarts.</p>
      <div className="space-y-3">{groups.map(([group, fields], index) => <Collapsible key={group} defaultOpen={index < 3} className={card}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-3.5 text-left">
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="text-[14px] font-medium">{group}</span><span className={cn(meta, "ml-auto")}>{fields.length}</span></CollapsibleTrigger>
        <CollapsibleContent><dl className="m-0 divide-y border-t px-5">{fields.map((field) =>
          <div key={field.path.join(".")} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 py-2.5 text-[13px] max-[600px]:grid-cols-1 max-[600px]:gap-1">
            <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{(group === "general" ? field.path : field.path.slice(1)).join(".")}</dt>
            <dd className="m-0 min-w-0">{formatValue(field)}</dd></div>)}</dl></CollapsibleContent>
      </Collapsible>)}</div>
      {value.truncated && <p className={cn(meta, "mt-3")}>Only the first 500 settings are listed.</p>}
    </>}
  </Status>;
}
