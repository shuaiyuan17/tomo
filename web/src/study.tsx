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
import { formatWhen, studyLabel, STUDY_PAGES, useResource, type StudyPage } from "./study-data.js";
import { i18n, Trans, useTranslation } from "./i18n/index.js";
import { deferred, say, type Message } from "./i18n/message.js";

import { card, Empty, meta, Status, type Mutator } from "./study-ui.js";
import { LanguageSetting } from "./language-setting.js";

/** Keys this file picks at runtime, from a literal map (tests/i18n-catalogs.test.ts). */
// i18n-dynamic: study:intro.*
// i18n-dynamic: study:mcp.status.*
// i18n-dynamic: study:mcp.oauth.*
// i18n-dynamic: study:mcp.reconnect.*


const INTRO = {
  todos: "intro.todos", memory: "intro.memory", context: "intro.context", model: "intro.model",
  cost: "intro.cost", cron: "intro.cron", mcp: "intro.mcp", config: "intro.config",
} as const satisfies Record<StudyPage, string>;

export function Study({ page, onPage, session, reload, inert, mutator, focus, cronRevision = 0 }: { page: StudyPage; onPage: (page: StudyPage) => void; session?: WebSession; reload: number; inert?: boolean; mutator: Mutator;
  /** An item to scroll to and highlight (`#study/cron/<jobId>`). */ focus?: string | null; cronRevision?: number }) {
  const [local, setLocal] = useState(0);
  const agent = useAgentName();
  const { t } = useTranslation(["study", "common"]);
  const key = reload + local;
  return <main id="study" tabIndex={-1} inert={inert} className="mx-auto flex min-h-0 w-full max-w-[1040px] min-w-0 flex-1 flex-col px-10 pt-3 max-[1024px]:px-6 max-[800px]:px-5 max-[600px]:px-4 max-[600px]:pt-1">
    {/* The top bar names the Study; the tabs name the page. No title block or description above them. */}
    <h1 className="sr-only">{studyLabel(page)}</h1>
    <Tabs value={page} onValueChange={(value) => onPage(value as StudyPage)} className="min-h-0 flex-1 gap-0">
      <div className="flex items-center gap-2 border-b">
      <TabsList aria-label={t("sections")} className="h-auto min-w-0 flex-1 justify-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x rounded-none bg-transparent p-0 [scrollbar-width:none] max-[800px]:pr-8 max-[800px]:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)]">
        {STUDY_PAGES.map((value) => <TabsTrigger key={value} value={value} title={t(INTRO[value], { agent })}
          className="-mb-px h-10 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent! px-3 text-[13px] font-medium text-muted-foreground shadow-none! hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground dark:data-[state=active]:border-primary">{studyLabel(value)}</TabsTrigger>)}
      </TabsList>
      <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-foreground/[0.07] [&_svg:not([class*='size-'])]:size-4" aria-label={t("refresh")} title={t("refresh")} onClick={() => setLocal((v) => v + 1)}><RefreshCw strokeWidth={1.75} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-5 pb-10 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]" role="tabpanel" aria-label={studyLabel(page)}>
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
  const { t } = useTranslation(["study", "common"]);
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
  if (tree.state === "ready" && tree.value.missing) return <Empty>{t("memory.missing")}</Empty>;
  return <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-6 max-[900px]:grid-cols-1">
    <div className="flex min-w-0 flex-col gap-3">
      <form onSubmit={submit} role="search" className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
        <label htmlFor="memory-search" className="sr-only">{t("memory.search")}</label>
        <Input id="memory-search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("memory.search")} maxLength={200}
          className="h-10 rounded-xl bg-card pr-9 pl-9 text-[13px] md:text-[13px]" />
        {query && <Button type="button" variant="ghost" size="icon" aria-label={t("memory.clearSearch")} onClick={() => { setDraft(""); setQuery(""); }}
          className="absolute top-1/2 right-1 size-8 -translate-y-1/2 rounded-lg text-muted-foreground"><X /></Button>}
      </form>
      <div className={cn(card, "min-h-0 overflow-hidden")}>
        <ScrollArea className="h-[min(560px,calc(100dvh-340px))] max-[900px]:h-64">
          <div className="p-2">
            {query ? <Status resource={search} empty={search.state === "ready" && !search.value.results.length ? <p className="m-2 text-[13px] text-muted-foreground">{t("memory.noMatches")}</p> : undefined}>
              <ul className="m-0 list-none space-y-0.5 p-0">{search.state === "ready" && search.value.results.map((hit, i) =>
                <li key={`${hit.path}:${hit.line}:${i}`}><button type="button" onClick={() => setSelected(hit.path)}
                  className={cn("block w-full rounded-lg px-2.5 py-2 text-left hover:bg-foreground/[0.06]", selected === hit.path && "bg-foreground/[0.06]")}>
                  <span className={cn(meta, "block")}>{hit.path}:{hit.line}</span>
                  <span className="block truncate text-[13px]">{hit.text}</span></button></li>)}</ul>
              {search.state === "ready" && search.value.truncated && <p className={cn(meta, "m-2")}>{t("memory.searchTruncated")}</p>}
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
              {tree.state === "ready" && tree.value.truncated && <p className={cn(meta, "m-2")}>{t("memory.treeTruncated")}</p>}</Status>}
          </div>
        </ScrollArea>
      </div>
    </div>
    <div className="min-w-0">
      {!selected ? <Empty>{t("memory.choose")}</Empty> : <Status resource={file}>
        {file.state === "ready" && <article className={cn(card, "px-7 py-6 max-[600px]:px-5")} aria-label={file.value.path}>
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-3">
            <h2 className="m-0 font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{file.value.path}</h2>
            <span className={cn(meta, "ml-auto")}>{t("memory.updated", { when: formatWhen(file.value.modifiedAt) })}</span></div>
          {file.value.hiddenLines > 0 && <p className={cn(meta, "mt-0 mb-3 flex items-center gap-1.5")}><Lock className="size-3" />{t("memory.hiddenLines", { count: file.value.hiddenLines })}</p>}
          <div className="markdown"><Text>{file.value.content}</Text></div>
        </article>}
      </Status>}
    </div>
  </div>;
}

function Context({ session, reload }: { session?: WebSession; reload: number }) {
  const { t } = useTranslation(["study", "common"]);
  const [resource] = useResource<WebContext>(session ? `/sessions/${session.id}/context` : null, reload);
  if (!session) return <Empty>{t("chooseConversation")}</Empty>;
  return <Status resource={resource}>{resource.state === "ready" && <ContextView value={resource.value} title={session.title} />}</Status>;
}

const MCP_TONE: Record<string, string> = { connected: "bg-primary", failed: "bg-destructive", "needs-auth": "bg-destructive/70", pending: "bg-muted-foreground", disabled: "bg-border" };
const MCP_LABEL: Record<string, "mcp.status.connected" | "mcp.status.failed" | "mcp.status.needsAuth" | "mcp.status.pending" | "mcp.status.disabled"> = {
  connected: "mcp.status.connected", failed: "mcp.status.failed", "needs-auth": "mcp.status.needsAuth", pending: "mcp.status.pending", disabled: "mcp.status.disabled" };
const MCP_OAUTH = { ready: null, "login-required": "mcp.oauth.loginRequired", "auth-pending": "mcp.oauth.authPending", "auth-failed": "mcp.oauth.authFailed" } as const satisfies Record<WebMcpOAuthState, string | null>;
const MCP_RECONNECT = {
  reconnected: "study:mcp.reconnect.reconnected", failed: "study:mcp.reconnect.failed", "no-live-session": "study:mcp.reconnect.noLiveSession",
} as const satisfies Record<WebMcpReconnectResult["outcome"], string>;

/** One server's Reconnect button, on the owner conversation's live session. */
function McpReconnect({ server, mutator, onDone }: { server: string; mutator: Mutator; onDone: () => void }) {
  const { t } = useTranslation(["study", "common"]);
  const [busy, setBusy] = useState(false);
  /** How the reconnect went, worded at render. */
  const [note, setNote] = useState<Message | null>(null);
  const run = async () => {
    if (!mutator.bootstrap) return;
    setBusy(true); setNote(null);
    try {
      const value = await mutate<WebMcpReconnectResult>("/mcp/reconnect", "POST", { server }, mutator.bootstrap, mutator.refresh);
      setNote(deferred.t(MCP_RECONNECT[value.outcome])); onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setNote(deferred.t(code === "session_busy" ? "study:mcp.reconnect.busy"
        : code === "epoch_changed" ? "study:mcp.reconnect.restarted" : "study:mcp.reconnect.unavailable"));
    } finally { setBusy(false); }
  };
  return <span className="inline-flex items-center gap-2">
    <Button variant="outline" size="sm" className="h-7 rounded-lg px-2.5 text-[12px]" disabled={busy || !mutator.bootstrap || !mutator.live} onClick={() => void run()}>
      <RefreshCw className={cn("size-3", busy && "animate-spin")} />{busy ? t("mcp.reconnect.running") : t("mcp.reconnect.action")}</Button>
    {note && <span className={meta} role="status">{say(note)}</span>}</span>;
}

function Mcp({ reload, mutator, ownerId }: { reload: number; mutator: Mutator; ownerId?: string | null }) {
  const { t } = useTranslation(["study", "common"]);
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
    ? t("mcp.emptyNoSession")
    : t("mcp.empty")}</Empty> : undefined}>
    {value && <>
      {!value.live.available ? <p className={cn(meta, "mt-0 mb-3")}>{t("mcp.liveUnavailable")}</p>
        : !value.live.sessions.length && <p className={cn(meta, "mt-0 mb-3")}>{t("mcp.noLiveSession")}</p>}
      <ul className="m-0 list-none space-y-3 p-0">{rows.map(({ name, server }) => {
        const live = value.live.sessions.flatMap((s) => s.connections === null ? [{ sessionId: s.sessionId, status: "unknown" }]
          : s.connections.filter((c) => c.name === name).map((c) => ({ sessionId: s.sessionId, status: c.status as string })));
        const oauth = value.live.oauth.find((entry) => entry.name === name)?.oauth;
        const oauthKey = oauth ? MCP_OAUTH[oauth] : null;
        const enabled = server?.enabled ?? true;
        const ownerReports = live.some((item) => item.sessionId === ownerId && item.status !== "unknown" && item.status !== "disabled");
        return <li key={name} className={cn(card, "px-5 py-4", !enabled && "opacity-75")}>
          <div className="flex flex-wrap items-center gap-2"><h2 className="m-0 font-mono text-[14px] font-medium">{name}</h2>
            {server ? <>
              <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">{server.type}</Badge>
              <Badge variant={server.enabled ? "secondary" : "outline"} className="rounded-md text-[10px] font-normal tracking-[0.02em]">{server.enabled ? t("mcp.enabled") : t("mcp.disabled")}</Badge>
              {server.oauth && <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">OAuth</Badge>}
              {server.alwaysLoad && <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">{t("mcp.alwaysLoaded")}</Badge>}
            </> : <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em]">{t("mcp.sessionProvided")}</Badge>}
            {ownerLive && ownerReports && <span className="ml-auto"><McpReconnect server={name} mutator={mutator} onDone={refetch} /></span>}</div>
          {server && <p className={cn(meta, "mt-1.5 mb-0 flex flex-wrap items-center gap-x-1.5")}>
            {server.configured.length ? <><Lock className="size-3" />{t("mcp.configured", { names: server.configured.join(" · ") })}</> : t("mcp.noSettings")}
            {server.timeout !== null && <>{t("mcp.timeout", { seconds: server.timeout })}</>}</p>}
          <div className="mt-3 text-[13px]">{!enabled ? <span className="text-muted-foreground">{t("mcp.notLoadedDisabled")}</span>
            : !live.length ? <span className="text-muted-foreground">{!value.live.available ? t("mcp.statusUnknown") : value.live.sessions.length ? t("mcp.notLoaded") : t("mcp.noSession")}</span>
            : <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">{live.map((item) => <li key={item.sessionId} className="flex items-center gap-1.5">
              <i className={cn("size-1.5 rounded-full", MCP_TONE[item.status] ?? "bg-border")} /><span>{MCP_LABEL[item.status] ? t(MCP_LABEL[item.status]) : t("mcp.status.noAnswer")}</span>
              <span className={meta}>{item.sessionId === ownerId ? (live.length > 1 ? t("mcp.yourConversation") : "") : item.sessionId.slice(0, 6)}</span></li>)}</ul>}
            {oauthKey && <p className={cn(meta, "mt-1.5 mb-0")}><Trans t={t} ns="study" i18nKey="mcp.oauth.hint" values={{ state: t(oauthKey), name }} components={{ cmd: <span className="font-mono" /> }} /></p>}</div>
        </li>;
      })}</ul></>}
  </Status>;
}

function formatValue(field: WebConfigField): ReactNode {
  const t = i18n.getFixedT(null, "study");
  if (field.secret) return <span className="flex items-center gap-1.5 text-muted-foreground"><Lock className="size-3" />
    {!field.set ? t("config.notSet") : field.length !== undefined ? <><span aria-hidden="true" className="font-mono tracking-widest">•••</span><span className="sr-only">{t("config.hidden")}</span><span className="font-mono text-[11px]">{t("config.chars", { count: field.length })}</span></> : t("config.set")}</span>;
  const value = field.value;
  if (value === undefined || value === null || value === "") return <span className="text-muted-foreground">—</span>;
  if (Array.isArray(value)) return value.length ? <span className="font-mono text-xs [overflow-wrap:anywhere]">{value.map(String).join(", ")}</span> : <span className="text-muted-foreground">{t("config.empty")}</span>;
  if (typeof value === "object") return <span className="text-muted-foreground">{t("config.empty")}</span>;
  return <span className="font-mono text-xs [overflow-wrap:anywhere]">{String(value)}</span>;
}

function Config({ reload }: { reload: number }) {
  const { t } = useTranslation(["study", "common"]);
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
  return <>
    <LanguageSetting />
    <Status resource={resource} empty={value?.missing ? <Empty>{t("config.missing")}</Empty> : undefined}>
    {value && <>
      <p className={cn(meta, "mt-0 mb-4")}>{t("config.note", { when: formatWhen(value.modifiedAt) })}</p>
      <div className="space-y-3">{groups.map(([group, fields], index) => <Collapsible key={group} defaultOpen={index < 3} className={card}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-3.5 text-left">
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="text-[14px] font-medium">{group === "general" ? t("config.general") : group}</span><span className={cn(meta, "ml-auto")}>{fields.length}</span></CollapsibleTrigger>
        <CollapsibleContent><dl className="m-0 divide-y border-t px-5">{fields.map((field) =>
          <div key={field.path.join(".")} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 py-2.5 text-[13px] max-[600px]:grid-cols-1 max-[600px]:gap-1">
            <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{(group === "general" ? field.path : field.path.slice(1)).join(".")}</dt>
            <dd className="m-0 min-w-0">{formatValue(field)}</dd></div>)}</dl></CollapsibleContent>
      </Collapsible>)}</div>
      {value.truncated && <p className={cn(meta, "mt-3")}>{t("config.truncated")}</p>}
    </>}
  </Status></>;
}
