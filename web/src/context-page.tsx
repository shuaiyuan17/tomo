/* The Study's Context tab: how full the window is, what fills it, and what has been rolled up (see docs/web-ui.md). */
import { ChevronRight } from "lucide-react";
import type { WebContext } from "../../src/web/protocol.js";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { compactionFreed, composeWindow, FILL_LABELS, fillPercent, fillTone, formatPercent, rollupCounts, rollupTitle,
  type FillTone, type WindowComposition, type WindowSegment } from "./context-view.js";
import { card, meta, Section, Stat } from "./cost-charts.js";
import { Text } from "./markdown.js";
import { formatTokens, formatWhen } from "./study-data.js";

/**
 * The meter is one hue, chosen by how full the window is; the conversation is
 * that hue solid and the always-loaded part a tint of it, so the fill level
 * reads from the colour and the make-up from the tint. Never colour alone:
 * the state is also written beside the number, and every piece is in the legend.
 */
const SOLID: Record<FillTone, string> = { calm: "bg-primary", warn: "bg-warn", critical: "bg-destructive" };
const TINT: Record<FillTone, string> = { calm: "bg-primary/45", warn: "bg-warn/45", critical: "bg-destructive/45" };
const HATCH = "bg-[repeating-linear-gradient(135deg,var(--muted-foreground)_0_1.5px,transparent_1.5px_5px)] opacity-60";
const TRACK = "bg-foreground/[0.09]";
const SEGMENT_NAMES: Record<WindowSegment["kind"], string> = { conversation: "Conversation", fixed: "Always loaded", used: "Used", reserved: "Compact buffer" };
const segmentClass = (kind: WindowSegment["kind"], tone: FillTone) => kind === "reserved" ? HATCH : kind === "fixed" ? TINT[tone] : SOLID[tone];

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-[2px] align-baseline", className)} />;
}

/** The window as one bar: used pieces from the left with 2px gaps, the rest free. */
export function WindowMeter({ used, max, segments, tone }: { used: number; max: number; segments: WindowSegment[]; tone: FillTone }) {
  return <div role="meter" aria-label="Context tokens used" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(used, max)}
    aria-valuetext={`${formatPercent(fillPercent(used, max))} used, ${FILL_LABELS[tone].toLowerCase()}`} data-tone={tone}
    className={cn("flex h-3 w-full gap-[2px] overflow-hidden rounded-full", TRACK)}>
    {segments.map((segment) => <span key={segment.kind} data-segment={segment.kind} title={`${SEGMENT_NAMES[segment.kind]}: ${segment.tokens.toLocaleString()} tokens`}
      className={cn("h-full min-w-[3px] shrink-0 transition-[width] duration-300 first:rounded-l-full", segmentClass(segment.kind, tone))} style={{ width: `${segment.percent}%` }} />)}
  </div>;
}

function Window({ value, title, parts }: { value: WebContext; title: string; parts: WindowComposition }) {
  const recorded = <span className={cn(meta, "text-right")}>{value.recordedAt ? `Last recorded ${formatWhen(value.recordedAt)}` : "No turn recorded yet"}</span>;
  if (!value.max || value.used === null) return <section className={cn(card, "px-6 py-5 max-[600px]:px-4 max-[600px]:py-4")} aria-labelledby="ctx-window">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="eyebrow" id="ctx-window">Context window · {title}</h2>{recorded}</div>
    <p className="mt-2 mb-0 text-sm text-muted-foreground">Unavailable until a turn reports its context window.</p>
  </section>;
  const percent = fillPercent(value.used, value.max);
  const tone = fillTone(percent);
  const share = (tokens: number) => `${formatPercent(fillPercent(tokens, value.max!))} of the window`;
  const split = parts.segments.some((segment) => segment.kind === "conversation" || segment.kind === "fixed");
  return <section className={cn(card, "px-6 py-5 max-[600px]:px-4 max-[600px]:py-4")} aria-labelledby="ctx-window">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="eyebrow" id="ctx-window">Context window · {title}</h2>{recorded}</div>
    <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <p className="m-0 flex items-baseline gap-3">
        <span className="font-serif text-[52px] leading-none tracking-[-1.5px] tabular-nums max-[600px]:text-[44px]">{formatPercent(percent)}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium" data-tone={tone}>
          <span aria-hidden className={cn("size-1.5 rounded-full", SOLID[tone])} />{FILL_LABELS[tone]}</span>
      </p>
      <p className="m-0 text-right text-[13px] text-muted-foreground max-[600px]:text-left">
        <span className="text-[15px] font-medium text-foreground tabular-nums">{value.used.toLocaleString()}</span> of <span className="tabular-nums">{value.max.toLocaleString()}</span> tokens
        <span className="block text-[12px]">{value.estimated ? "Estimated" : "Reported by the model"} at the end of the last turn</span></p>
    </div>
    <div className="mt-4"><WindowMeter used={value.used} max={value.max} segments={parts.segments} tone={tone} /></div>
    <div className="mt-4 grid grid-cols-4 gap-x-6 gap-y-4 max-[700px]:grid-cols-2">
      {split ? <>
        <Stat label={<><Swatch className={SOLID[tone]} />Conversation</>} value={formatTokens(parts.conversation)} note={share(parts.conversation)} />
        <Stat label={<><Swatch className={TINT[tone]} />Always loaded</>} value={formatTokens(parts.fixed)} note={share(parts.fixed)} />
      </> : <Stat label={<><Swatch className={SOLID[tone]} />Used</>} value={formatTokens(value.used)} note={share(value.used)} />}
      {parts.reserved > 0 && <Stat label={<><Swatch className={HATCH} />Compact buffer</>} value={formatTokens(parts.reserved)} note="kept for compaction" />}
      <Stat label={<><Swatch className={cn(TRACK, "ring-1 ring-border ring-inset")} />Free</>} value={formatTokens(parts.free)} note={share(parts.free)} />
    </div>
  </section>;
}

/** Rows ranked by size: a name, a bar scaled to the largest row, and the figure. */
function Rows({ rows, total, label }: { rows: Array<{ name: string; tokens: number }>; total: number; label: string }) {
  const top = Math.max(1, ...rows.map((row) => row.tokens));
  return <ul aria-label={label} className="m-0 list-none space-y-2.5 p-0">{rows.map((row) =>
    <li key={row.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[13px]">
      <span className="truncate">{row.name}</span>
      <span className="text-right tabular-nums">{formatTokens(row.tokens)}<span className="ml-2 inline-block w-9 text-[11px] text-muted-foreground">{formatPercent(fillPercent(row.tokens, total))}</span></span>
      <span className={cn("col-span-2 mt-1 h-1 rounded-full", TRACK)}><span className="block h-1 min-w-[2px] rounded-full bg-primary/70" style={{ width: `${row.tokens / top * 100}%` }} /></span>
    </li>)}</ul>;
}

function toolList(tools: string[], limit: number): string {
  return tools.slice(0, limit).map((tool) => tool.replace(/:(\d+)$/, " ×$1")).join(", ") + (tools.length > limit ? ", …" : "");
}

function Stretches({ value }: { value: WebContext }) {
  const sections = value.analysis ? [...value.analysis.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 12) : [];
  const top = Math.max(1, ...sections.map((section) => section.tokens));
  return <Section title="Largest stretches of the transcript" aside={value.analysis && <>{value.analysis.totalMessages.toLocaleString()} messages · ≈{formatTokens(value.analysis.totalTokens)} tokens</>}>
    {value.analysisStatus === "too_large" ? <p className="m-0 text-[13px] text-muted-foreground">The transcript is too large to analyse here. Use <code className="font-mono">tomo lcm stats</code>.</p>
      : !value.analysis || !sections.length ? <p className="m-0 text-[13px] text-muted-foreground">No transcript to analyse yet.</p>
      : <ul className="m-0 list-none space-y-3 p-0">{sections.map((section) =>
        <li key={section.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[13px]">
          <span className="min-w-0 truncate"><span className={cn(meta, "mr-2 tabular-nums")}>#{section.id}</span>
            {section.type === "conversation" ? "Conversation" : section.type === "tool_ops" ? `Tools: ${toolList(section.toolsUsed, 4)}` : `Conversation and tools: ${toolList(section.toolsUsed, 3)}`}</span>
          <span className="text-right tabular-nums">{formatTokens(section.tokens)}</span>
          <span className={cn("col-span-2 mt-1 h-1 rounded-full", TRACK)}><span className="block h-1 min-w-[2px] rounded-full bg-primary/70" style={{ width: `${section.tokens / top * 100}%` }} /></span>
          <span className={cn(meta, "col-span-2 mt-1")}>{section.messageCount} messages{section.toolCallCount ? ` · ${section.toolCallCount} tool calls` : ""} · {formatWhen(Date.parse(section.earliestAt))}</span>
        </li>)}</ul>}
  </Section>;
}

function Rollups({ value }: { value: WebContext }) {
  const counts = rollupCounts(value.summaries);
  return <Section title="Rolled-up history" aside={value.summaries.length > 0 && counts.map((c) => `${c.count} ${c.level}`).join(" · ")}>
    {!value.summaries.length ? <p className="m-0 text-[13px] text-muted-foreground">No summary blocks in this session yet.</p>
      : <ol aria-label="Rollup blocks, newest first" className="m-0 list-none p-0">{value.summaries.map((block, i) =>
        <li key={`${block.tag}:${block.timestamp}:${i}`} className="relative pb-2 pl-6 last:pb-0">
          {/* The timeline: a rail through every block, and a dot on each. */}
          <span aria-hidden className={cn("absolute top-0 bottom-0 left-[5px] w-px bg-border", i === 0 && "top-4", i === value.summaries.length - 1 && "bottom-auto h-4")} />
          <span aria-hidden className={cn("absolute top-[13px] left-[1px] size-[9px] rounded-full border-2 border-primary/70 bg-card", block.level === "legacy" && "border-muted-foreground/60")} />
          <Collapsible className="rounded-lg border bg-background/50 data-[state=open]:bg-background/80">
            <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-foreground/[0.04]">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <span className="min-w-0 truncate font-medium" title={block.tag}>{rollupTitle(block.tag)}</span>
              <Badge variant="outline" className="rounded-md text-[10px] font-normal tracking-[0.02em] text-muted-foreground">{block.level}</Badge>
              <span className="ml-auto flex items-baseline gap-3">
                {block.eventsSummarized > 0 && <span className="text-[12px] tabular-nums">{block.eventsSummarized.toLocaleString()} <span className="text-muted-foreground">{block.eventsSummarized === 1 ? "event" : "events"}</span></span>}
                {block.timestamp && <span className={meta}>rolled up {formatWhen(Date.parse(block.timestamp))}</span>}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-4 pt-3 pb-3"><div className="markdown text-[14px]"><Text>{block.content}</Text></div>
              {block.truncated && <p className={cn(meta, "mb-0")}>Preview shortened.</p>}</CollapsibleContent>
          </Collapsible></li>)}</ol>}
    {value.summariesTruncated && <p className={cn(meta, "mt-3 mb-0")}>Only the 100 most recent blocks are listed.</p>}
  </Section>;
}

function Compactions({ value }: { value: WebContext }) {
  const list = value.recentCompactions?.slice().reverse() ?? [];
  if (!list.length) return null;
  const top = Math.max(1, ...list.map((c) => c.preTokens ?? 0));
  return <Section title="Compactions since Tomo started" aside={<>{list.length} seen</>}>
    <ul className="m-0 list-none space-y-3 p-0">{list.map((c, i) => { const freed = compactionFreed(c.preTokens, c.postTokens);
      return <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 text-[13px]">
        <span>{formatWhen(c.timestamp)}</span>
        <span className="text-right tabular-nums">{c.preTokens !== undefined ? formatTokens(c.preTokens) : "?"} <span className="text-muted-foreground">→</span> {c.postTokens !== undefined ? formatTokens(c.postTokens) : "?"}
          {freed !== null && <span className="ml-2 text-[11px] text-muted-foreground">−{formatPercent(freed)}</span>}</span>
        {/* Before as the tinted length, after as the solid one, on one scale across the list. */}
        {c.preTokens !== undefined && <span className={cn("relative col-span-2 mt-1 h-1 rounded-full", TRACK)}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-primary/30" style={{ width: `${c.preTokens / top * 100}%` }} />
          {c.postTokens !== undefined && <span className="absolute inset-y-0 left-0 min-w-[2px] rounded-full bg-primary/80" style={{ width: `${Math.min(c.postTokens, c.preTokens) / top * 100}%` }} />}</span>}
      </li>; })}</ul>
  </Section>;
}

/** The page for one loaded reading: no fetching, so it can be rendered as is. */
export function ContextView({ value, title }: { value: WebContext; title: string }) {
  const parts = composeWindow(value.breakdown, value.used ?? 0, value.max ?? 0);
  return <div className="space-y-5">
    <Window value={value} title={title} parts={parts} />
    <div className="grid grid-cols-2 items-start gap-5 max-[1100px]:grid-cols-1">
      {parts.counted.length > 0 && <Section title="What fills it" aside={<>{formatTokens(value.used ?? 0)} used</>}>
        <Rows rows={parts.counted} total={value.used ?? 0} label="What fills the window" />
        {parts.deferred.length > 0 && <div className="mt-5 border-t pt-4">
          <p className="eyebrow">Not loaded</p>
          <p className="mt-1 mb-3 text-[12px] text-muted-foreground">Tool definitions deferred until they are needed. They take no room in the window.</p>
          <ul aria-label="Deferred, not in the window" className="m-0 list-none space-y-1.5 p-0">{parts.deferred.map((row) =>
            <li key={row.name} className="flex items-baseline justify-between gap-3 text-[13px] text-muted-foreground"><span className="truncate">{row.name}</span><span className="tabular-nums">{formatTokens(row.tokens)}</span></li>)}</ul>
        </div>}
      </Section>}
      <Stretches value={value} />
    </div>
    <Rollups value={value} />
    <Compactions value={value} />
  </div>;
}

