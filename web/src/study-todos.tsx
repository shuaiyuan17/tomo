import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, X } from "lucide-react";
import type { WebTodoItem, WebTodoResolution, WebTodos } from "../../src/web/protocol.js";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useAgentName } from "./agent-name.js";
import { LINK_PROPS } from "./links.js";
import { useResource } from "./study-data.js";
import { closedLabel, groupTodos, isDue, refTarget, reviewLabel, snoozeLabel, summarizeTodos, type TodoSummary, type WaitingOn } from "./todos.js";

const card = "rounded-xl border bg-card shadow-xs";
const meta = "text-[11px] tracking-[0.02em] text-muted-foreground";

/** "Due today" turns over at midnight; re-read the clock while the page is open. */
function useNow(resource: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [resource]);
  return now;
}

/**
 * The Study's Todos page: the todo store's open items by who moves next, due
 * ones first, with how close the list is to its cap and what was recently
 * closed. Read-only: todos change through the agent's todo tools and `/todo`.
 */
export function Todos({ reload }: { reload: number }) {
  const [resource] = useResource<WebTodos>("/todos", reload);
  const agent = useAgentName();
  const now = useNow(resource);
  if (resource.state === "loading") return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (resource.state === "error") {
    return <div className={cn(card, "px-4 py-3 text-[13px]")} role="alert">{resource.code === "todos_unavailable"
      ? "The todo store could not be read. Nothing was changed." : resource.code === "request_limit" ? "Busy — try again in a moment." : "Unavailable right now."}</div>;
  }
  const value = resource.value;
  const summary = summarizeTodos(value, now);
  const groups = groupTodos(value.items, now);
  const headings: Record<WaitingOn, string> = { owner: "Waiting on you", me: `Waiting on ${agent}`, external: "Waiting on others" };
  return <div className="space-y-6">
    <Summary summary={summary} agent={agent} />
    {groups.length === 0 && <div className={cn(card, "px-5 py-8 text-center text-sm text-muted-foreground")}>
      {summary.hidden > 0 ? "No open todos in your conversations." : `No open todos. Ask ${agent} to keep track of something, or send /todo add.`}</div>}
    {groups.map((group) => <section key={group.waitingOn} aria-labelledby={`todos-${group.waitingOn}`}>
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2 id={`todos-${group.waitingOn}`} className="eyebrow">{headings[group.waitingOn]}</h2>
        <span className={cn(meta, "tabular-nums")}>{group.items.length}</span>
        {group.due > 0 && <span className="text-[11px] font-medium tracking-[0.02em] text-warn tabular-nums">{group.due} due</span>}
      </div>
      <ul className={cn(card, "m-0 list-none divide-y p-0")}>
        {group.items.map((item) => <TodoRow key={item.id} item={item} now={now} maxSnoozes={value.limits.maxSnoozes} />)}
      </ul>
    </section>)}
    {summary.hidden > 0 && <p className={cn(meta, "m-0 px-1")}>{summary.hidden} more open in conversations that are not shown here.</p>}
    {value.recent.length > 0 && <Recent recent={value.recent} total={value.resolvedTotal} now={now} agent={agent} />}
  </div>;
}

function Stat({ label, children, note, className }: { label: string; children: ReactNode; note?: ReactNode; className?: string }) {
  return <div className={cn("min-w-0 px-6 py-5 max-[600px]:px-5 max-[600px]:py-4", className)}>
    <p className="eyebrow">{label}</p>
    <div className="mt-1.5">{children}</div>
    {note && <p className={cn(meta, "mt-2 mb-0")}>{note}</p>}
  </div>;
}

function Summary({ summary, agent }: { summary: TodoSummary; agent: string }) {
  const left = summary.max - summary.open;
  return <section aria-label="Summary" className={cn(card, "grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] max-[600px]:grid-cols-2")}>
    <Stat label="Open" className="border-r max-[600px]:col-span-2 max-[600px]:border-r-0 max-[600px]:border-b" note={summary.cap === "full" ? `At the limit: ${agent} cannot add another until one is resolved.`
      : summary.cap === "near" ? `${left} left before ${agent} has to resolve one first.` : `${left} left before the limit.`}>
      <p className="m-0 text-2xl tabular-nums" data-testid="todo-open">{summary.open} <span className="text-sm text-muted-foreground">/ {summary.max}</span></p>
      <Progress value={summary.percent} aria-label={`${summary.open} of ${summary.max} open todos`}
        className={cn("mt-2.5 h-1.5", summary.cap !== "ok" && "bg-warn/20 [&>[data-slot=progress-indicator]]:bg-warn", summary.cap === "full" && "bg-destructive/20 [&>[data-slot=progress-indicator]]:bg-destructive")} />
    </Stat>
    <Stat label="Due for review" className="border-r" note={summary.due ? "Past their review date." : "Nothing is past its review date."}>
      <p className={cn("m-0 text-2xl tabular-nums", summary.due > 0 && "text-warn")} data-testid="todo-due">{summary.due}</p>
    </Stat>
    <Stat label="Waiting on you" note={`${summary.waiting.me} on ${agent} · ${summary.waiting.external} on others`}>
      <p className="m-0 text-2xl tabular-nums">{summary.waiting.owner}</p>
    </Stat>
  </section>;
}

/** A `ref` or a piece of evidence: a link when it has a safe target, plain text otherwise. */
function Ref({ value }: { value: string }) {
  const target = refTarget(value);
  // A path or an id reads as code; a sentence of evidence reads as text.
  if (!target.href) return <span className={cn("[overflow-wrap:anywhere]", !/\s/.test(target.label) && "font-mono")}>{target.label}</span>;
  return <a href={target.href} {...LINK_PROPS} title={target.href}
    className="inline-flex min-w-0 items-center gap-0.5 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
    <span className="[overflow-wrap:anywhere]">{target.label}</span><ArrowUpRight className="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /></a>;
}

/** Meta fragments on one wrapping line, separated by middle dots. */
function MetaLine({ children }: { children: ReactNode[] }) {
  const parts = children.filter(Boolean);
  if (!parts.length) return null;
  return <p className={cn(meta, "mt-1.5 mb-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5")}>
    {parts.map((part, i) => <span key={i} className="inline-flex min-w-0 items-baseline gap-x-1.5">{i > 0 && <span aria-hidden="true">·</span>}{part}</span>)}</p>;
}

function TodoRow({ item, now, maxSnoozes }: { item: WebTodoItem; now: number; maxSnoozes: number }) {
  const due = isDue(item, now);
  const snooze = snoozeLabel(item.snoozes, maxSnoozes);
  const review = new Date(item.reviewAt);
  return <li data-todo={item.id} data-due={due || undefined}
    className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-baseline gap-x-3 px-5 py-3.5 max-[600px]:grid-cols-[40px_minmax(0,1fr)] max-[600px]:px-4">
    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{item.id}</span>
    <div className="min-w-0">
      <p className="m-0 text-sm leading-snug font-medium [overflow-wrap:anywhere]">{item.title}</p>
      {item.next !== item.title && <p className="mt-1 mb-0 text-[13px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
        <span className="mr-1.5 text-[10.5px] font-medium tracking-[0.08em] uppercase">Next</span><span className="text-foreground/85">{item.next}</span></p>}
      <MetaLine>
        {item.ref && <Ref value={item.ref} />}
        {snooze && <span className={cn(snooze.last && "text-warn")}>{snooze.text}{snooze.last ? ", none left" : ""}{item.snoozeReason ? `: ${item.snoozeReason}` : ""}</span>}
        {item.group && <span>In {item.group}</span>}
        {item.source === "owner" && <span>Added by you</span>}
      </MetaLine>
    </div>
    <time dateTime={review.toISOString()} title={review.toLocaleString()} className="max-[600px]:col-start-2 max-[600px]:mt-1.5 max-[600px]:justify-self-start">
      {due ? <Badge variant="outline" className="rounded-md border-warn/40 bg-warn/10 text-[11px] font-medium text-warn">{reviewLabel(item.reviewAt, now)}</Badge>
        : <span className={cn(meta, "whitespace-nowrap")}>{reviewLabel(item.reviewAt, now)}</span>}
    </time>
  </li>;
}

function Recent({ recent, total, now, agent }: { recent: WebTodoResolution[]; total: number; now: number; agent: string }) {
  return <Collapsible asChild><section className={card} aria-label="Recently closed">
    <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-5 py-3.5 text-left hover:bg-foreground/[0.04] max-[600px]:px-4">
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      <span className="eyebrow">Recently closed</span>
      <span className={cn(meta, "ml-auto tabular-nums")}>{total > recent.length ? `Latest ${recent.length} of ${total}` : `${total}`}</span>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <ul className="m-0 list-none divide-y border-t p-0">{recent.map((item) => {
        const done = item.resolution === "done";
        const at = new Date(item.resolvedAt);
        return <li key={item.id} data-todo={item.id} className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-baseline gap-x-3 px-5 py-3 max-[600px]:grid-cols-[40px_minmax(0,1fr)] max-[600px]:px-4">
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{item.id}</span>
          <div className="min-w-0">
            <p className={cn("m-0 text-[13px] leading-snug [overflow-wrap:anywhere]", !done && "text-muted-foreground line-through decoration-muted-foreground/50")}>{item.title}</p>
            <MetaLine>
              {item.reason && <span className="[overflow-wrap:anywhere]">{item.reason}</span>}
              {item.evidence && <Ref value={item.evidence} />}
              {item.group && <span>In {item.group}</span>}
            </MetaLine>
          </div>
          <time dateTime={at.toISOString()} title={at.toLocaleString()} className={cn(meta, "inline-flex items-center gap-1 whitespace-nowrap max-[600px]:col-start-2 max-[600px]:mt-1")}>
            {done ? <Check className="size-3 translate-y-px text-primary" strokeWidth={2} aria-hidden="true" /> : <X className="size-3 translate-y-px" strokeWidth={2} aria-hidden="true" />}
            {done ? "Done" : "Dropped"} {closedLabel(item.resolvedAt, now)} · by {item.resolvedBy === "owner" ? "you" : agent}
          </time>
        </li>;
      })}</ul>
    </CollapsibleContent>
  </section></Collapsible>;
}
