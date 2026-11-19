import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, FileText, Folder, Lock, RefreshCw, Search, X } from "lucide-react";
import { ApiError, mutate } from "./api.js";
import type { WebConfigField, WebConfigView, WebContext, WebMcpOAuthState, WebMcpReconnectResult, WebMcpView, WebMemoryFile, WebMemorySearch, WebMemoryTree,
  WebSession } from "../../src/web/protocol.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAgentName } from "./agent-name.js";
import { Text } from "./markdown.js";
import { ContextView } from "./context-page.js";
import { CostPage } from "./cost-page.js";
import { Todos } from "./study-todos.js";
import { Cron } from "./study-cron.js";
import { ModelPage } from "./study-model.js";
import { formatWhen, STUDY_LABELS, STUDY_PAGES, useResource, type StudyPage } from "./study-data.js";
import { card, Empty, meta, Status, type Mutator } from "./study-ui.js";


const INTRO: Record<StudyPage, string> = {
  todos: "What {agent} is keeping track of, and who moves next. Read-only here: todos change in conversation or with /todo.",
  memory: "What {agent} remembers, as it is written in the workspace. Private memory is never shown in the browser.",
  context: "How full the selected conversation's context window is, what fills it, and what has been rolled up.",
  model: "Which model the selected conversation runs on. Your own conversation can be switched here.",
  cost: "What {agent}'s work would cost at API prices, day by day, and how much of your plan it is using.",
  cron: "Scheduled jobs and when they last ran.",
  mcp: "Tool servers in config.json and in live sessions, with the connection state the sessions report.",
  config: "The saved config.json. Only known non-sensitive text is shown; everything else is hidden.",
};

export function Study({ page, onPage, session, reload, inert, mutator, focus, cronRevision = 0 }: { page: StudyPage; onPage: (page: StudyPage) => void; session?: WebSession; reload: number; inert?: boolean; mutator: Mutator;
  /** An item to scroll to and highlight (`#study/cron/<jobId>`). */ focus?: string | null; cronRevision?: number }) {
  const [local, setLocal] = useState(0);
  const agent = useAgentName();
  const key = reload + local;
  return <main id="study" tabIndex={-1} inert={inert} className="mx-auto flex min-h-0 w-full max-w-[1040px] min-w-0 flex-1 flex-col px-12 pt-7 max-[1024px]:px-7 max-[800px]:px-5 max-[600px]:px-4 max-[600px]:pt-4">
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0"><p className="eyebrow">The Study</p>
        <h1 className="mt-1 mb-1 font-serif text-[30px] leading-tight font-normal tracking-[-0.5px] max-[600px]:text-[24px]">{STUDY_LABELS[page]}</h1>
        <p className="m-0 text-[13px] text-muted-foreground">{INTRO[page].replace("{agent}", agent)}</p></div>
      <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-xl text-muted-foreground hover:bg-foreground/[0.07]" aria-label="Refresh" title="Refresh" onClick={() => setLocal((v) => v + 1)}><RefreshCw strokeWidth={1.75} /></Button>
    </div>
    <Tabs value={page} onValueChange={(value) => onPage(value as StudyPage)} className="min-h-0 flex-1 gap-0">
      <TabsList aria-label="Study sections" className="h-auto w-full justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x rounded-none border-b bg-transparent p-0 [scrollbar-width:none] max-[800px]:pr-8 max-[800px]:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]">
        {STUDY_PAGES.map((value) => <TabsTrigger key={value} value={value}
          className="-mb-px h-10 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent! px-3 text-[13px] font-medium text-muted-foreground shadow-none! hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground dark:data-[state=active]:border-primary">{STUDY_LABELS[value]}</TabsTrigger>)}
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto pt-6 pb-10 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]" role="tabpanel" aria-label={STUDY_LABELS[page]}>
        {page === "todos" && <Todos reload={key} />}
        {page === "memory" && <Memory reload={key} />}
        {page === "context" && <Context session={session} reload={key} />}
        {page === "model" && <ModelPage session={session} reload={key} mutator={mutator} />}
        {page === "cost" && <CostPage reload={key} focus={focus ?? null} />}
        {page === "cron" && <Cron reload={key + cronRevision} mutator={mutator} focus={focus ?? null} />}
        {page === "mcp" && <Mcp reload={key} mutator={mutator} ownerId={mutator.bootstrap?.ownerId} />}
        {page === "config" && <Config reload={key} />}
      </div>
    </Tabs>
  </main>;
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

function Context({ session, reload }: { session?: WebSession; reload: number }) {
  const [resource] = useResource<WebContext>(session ? `/sessions/${session.id}/context` : null, reload);
  if (!session) return <Empty>Choose a conversation in the sidebar.</Empty>;
  return <Status resource={resource}>{resource.state === "ready" && <ContextView value={resource.value} title={session.title} />}</Status>;
}

const MCP_TONE: Record<string, string> = { connected: "bg-primary", failed: "bg-destructive", "needs-auth": "bg-destructive/70", pending: "bg-muted-foreground", disabled: "bg-border" };
const MCP_LABEL: Record<string, string> = { connected: "Connected", failed: "Failed", "needs-auth": "Needs sign-in", pending: "Connecting", disabled: "Disabled" };
const MCP_OAUTH: Record<WebMcpOAuthState, string | null> = { ready: null, "login-required": "Sign-in needed", "auth-pending": "Sign-in pending", "auth-failed": "Sign-in failed" };
const MCP_RECONNECT: Record<WebMcpReconnectResult["outcome"], string> = {
  reconnected: "Reconnected.", failed: "Reconnect failed. The log has the reason; /new starts a fresh session.",
  "no-live-session": "There is no live session to reconnect in. A new conversation connects every server afresh.",
};

/** One server's Reconnect button, on the owner conversation's live session. */
function McpReconnect({ server, mutator, onDone }: { server: string; mutator: Mutator; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const run = async () => {
    if (!mutator.bootstrap) return;
    setBusy(true); setNote("");
    try {
      const value = await mutate<WebMcpReconnectResult>("/mcp/reconnect", "POST", { server }, mutator.bootstrap, mutator.refresh);
      setNote(MCP_RECONNECT[value.outcome]); onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setNote(code === "session_busy" ? "A reply is in progress. Try again once it has finished."
        : code === "epoch_changed" ? "Tomo restarted since this page loaded. Refresh and try again." : "Reconnect is unavailable right now.");
    } finally { setBusy(false); }
  };
  return <span className="inline-flex items-center gap-2">
    <Button variant="outline" size="sm" className="h-7 rounded-lg px-2.5 text-[12px]" disabled={busy || !mutator.bootstrap || !mutator.live} onClick={() => void run()}>
      <RefreshCw className={cn("size-3", busy && "animate-spin")} />{busy ? "Reconnecting…" : "Reconnect"}</Button>
    {note && <span className={meta} role="status">{note}</span>}</span>;
}

function Mcp({ reload, mutator, ownerId }: { reload: number; mutator: Mutator; ownerId?: string | null }) {
  const [resource, refetch] = useResource<WebMcpView>("/mcp", reload);
  const value = resource.state === "ready" ? resource.value : undefined;
  // Configured servers, then those only a live session reports (tomo-internal, plugins).
  const rows = useMemo(() => {
    if (!value) return [];
    const known = new Set(value.servers.map((server) => server.name));
    const extra = [...new Set(value.live.sessions.flatMap((s) => (s.connections ?? []).map((c) => c.name)))].filter((name) => !known.has(name)).sort();
    return [...value.servers.map((server) => ({ name: server.name, server })), ...extra.map((name) => ({ name, server: undefined }))];
  }, [value]);
  const ownerLive = !!value?.live.sessions.some((s) => s.sessionId === ownerId);
  return <Status resource={resource} empty={value && !rows.length ? <Empty>{value.live.available && !value.live.sessions.length
    ? "No external MCP servers in config.json, and no live session to report the built-in ones."
    : "No MCP servers in config.json or reported by a live session."}</Empty> : undefined}>
    {value && <>
      {!value.live.available ? <p className={cn(meta, "mt-0 mb-3")}>Live connection status is unavailable right now.</p>
        : !value.live.sessions.length && <p className={cn(meta, "mt-0 mb-3")}>No live session: connection state appears once a conversation is running.</p>}
      <ul className="m-0 list-none space-y-3 p-0">{rows.map(({ name, server }) => {
        const live = value.live.sessions.flatMap((s) => s.connections === null ? [{ sessionId: s.sessionId, status: "unknown" }]
          : s.connections.filter((c) => c.name === name).map((c) => ({ sessionId: s.sessionId, status: c.status as string })));
        const oauth = value.live.oauth.find((entry) => entry.name === name)?.oauth;
        const oauthNote = oauth ? MCP_OAUTH[oauth] : null;
        const enabled = server?.enabled ?? true;
        const ownerReports = live.some((item) => item.sessionId === ownerId && item.status !== "unknown" && item.status !== "disabled");
        return <li key={name} className={cn(card, "px-5 py-4", !enabled && "opacity-75")}>
          <div className="flex flex-wrap items-center gap-2"><h2 className="m-0 font-mono text-[14px] font-medium">{name}</h2>
            {server ? <>
              <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">{server.type}</Badge>
              <Badge variant={server.enabled ? "secondary" : "outline"} className="rounded-md text-[10px] font-normal tracking-[0.02em]">{server.enabled ? "Enabled" : "Disabled"}</Badge>
              {server.oauth && <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">OAuth</Badge>}
              {server.alwaysLoad && <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">Always loaded</Badge>}
            </> : <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">Session-provided</Badge>}
            {ownerLive && ownerReports && <span className="ml-auto"><McpReconnect server={name} mutator={mutator} onDone={refetch} /></span>}</div>
          {server && <p className={cn(meta, "mt-1.5 mb-0 flex flex-wrap items-center gap-x-1.5")}>
            {server.configured.length ? <><Lock className="size-3" />{server.configured.join(" · ")} set</> : "No connection settings"}
            {server.timeout !== null && <> · timeout {server.timeout}s</>}</p>}
          <div className="mt-3 text-[13px]">{!enabled ? <span className="text-muted-foreground">Not loaded while disabled.</span>
            : !live.length ? <span className="text-muted-foreground">{!value.live.available ? "Status unknown." : value.live.sessions.length ? "Not loaded in any live session." : "No live session."}</span>
            : <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">{live.map((item) => <li key={item.sessionId} className="flex items-center gap-1.5">
              <i className={cn("size-1.5 rounded-full", MCP_TONE[item.status] ?? "bg-border")} /><span>{MCP_LABEL[item.status] ?? "Did not answer"}</span>
              <span className={meta}>{item.sessionId === ownerId ? (live.length > 1 ? "your conversation" : "") : item.sessionId.slice(0, 6)}</span></li>)}</ul>}
            {oauthNote && <p className={cn(meta, "mt-1.5 mb-0")}>{oauthNote}: send <span className="font-mono">/mcp login {name}</span> in your private chat.</p>}</div>
        </li>;
      })}</ul></>}
  </Status>;
}

function formatValue(field: WebConfigField): ReactNode {
  if (field.secret) return <span className="flex items-center gap-1.5 text-muted-foreground"><Lock className="size-3" />
    {!field.set ? "Not set" : field.length !== undefined ? <><span aria-hidden="true" className="font-mono tracking-widest">•••</span><span className="sr-only">Hidden</span><span className="font-mono text-[11px]">{field.length} chars</span></> : "Set"}</span>;
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
