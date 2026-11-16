/* The Study's Cost tab: a ten-week calendar on the left, the picked day on the right (see docs/web-ui.md). */
import { useEffect, useState, type ReactNode } from "react";
import type { WebCost, WebCostLimits } from "../../src/web/protocol.js";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { addDays, busiestHour, calendarStart, CATEGORIES, categoryOf, clock, costDayHash, dayEyebrow, hourLabel, localDate, longDay, pickDay,
  quotaWindows, resetsIn, share, shortDay, turnMeta, turnTitle, usd, versusTypical } from "./cost.js";
import { card, Columns, Est, Heatmap, Legend, meta, Ranked, Section, Stat } from "./cost-charts.js";
import { useResource, type Resource } from "./study-data.js";

const ERRORS: Record<string, string> = { cost_unavailable: "Cost data is not available on this install.", invalid_range: "That day cannot be shown." };
/** Calendar request: far enough back for ten Monday-to-Sunday weeks whatever the browser's own date is. */
const CALENDAR_SPAN_DAYS = 72;
const TOP_TURNS = 6;
type Range = "7" | "30";

function Failed({ resource }: { resource: Resource<unknown> }) {
  if (resource.state !== "error") return null;
  return <div className={cn(card, "px-4 py-3 text-[13px]")} role="alert">{ERRORS[resource.code] ?? "Cost is unavailable right now."}</div>;
}

export function CostPage({ reload, focus }: { reload: number; focus: string | null }) {
  const [calendar] = useResource<WebCost>(`/cost?from=${addDays(localDate(), -CALENDAR_SPAN_DAYS)}&top=0`, reload);
  const cal = calendar.state === "ready" ? calendar.value : undefined;
  const today = cal?.glance.today;
  const [requested, setRequested] = useState<string | null>(focus);
  // A link or Back/Forward changing the hash moves the page to that day.
  useEffect(() => { setRequested(focus); }, [focus]);
  const selected = today ? pickDay(requested, today) : null;
  const select = (date: string) => {
    setRequested(date);
    // Replace, not push: picking days is browsing one page, and Back should leave the Study.
    history.replaceState(history.state, "", window.location.pathname + window.location.search + costDayHash(date === today ? null : date));
  };
  const [day] = useResource<WebCost>(selected ? `/cost?from=${selected}&to=${selected}&top=${TOP_TURNS}` : null, reload);
  const [range, setRange] = useState<Range>("7");
  const [period] = useResource<WebCost>(today ? `/cost?from=${addDays(today, range === "7" ? -6 : -29)}&to=${today}&top=0` : null, reload);

  if (calendar.state === "loading") return <CostSkeleton />;
  if (calendar.state === "error") return <Failed resource={calendar} />;
  const value = cal!;
  const quota = value.limits ? <QuotaBar limits={value.limits} /> : null;
  if (value.recordedSince === null) return <div className="space-y-4">{quota}
    <div className={cn(card, "px-6 py-10 text-center")} role="status">
      <p className="m-0 font-serif text-[20px]">Nothing recorded yet</p>
      <p className="mx-auto mt-2 mb-0 max-w-[420px] text-[13px] leading-relaxed text-muted-foreground">Every turn from now on is written to the usage ledger, and its estimated cost shows up here as soon as it finishes.</p>
    </div></div>;

  const calendarDays = value.days.filter((d) => d.date >= calendarStart(value.glance.today));
  const recordedDays = calendarDays.filter((d) => d.recorded).length;
  return <div className="viz space-y-4">
    {quota}
    <div className="grid grid-cols-[minmax(0,340px)_minmax(0,1fr)] grid-rows-[auto_auto_1fr] items-start gap-4 [grid-template-areas:'cal_day'_'glance_day'_'range_day'] max-[900px]:grid-cols-2 max-[900px]:grid-rows-none max-[900px]:[grid-template-areas:'cal_glance'_'day_day'_'range_range'] max-[600px]:grid-cols-1 max-[600px]:[grid-template-areas:'cal'_'glance'_'day'_'range']">
      <Section title="Ten weeks" aside={recordedDays < 14 ? `since ${shortDay(localDate(value.recordedSince))}` : "pick a day"} className="[grid-area:cal]">
        <Heatmap days={calendarDays} today={value.glance.today} selected={selected!} onSelect={select} />
      </Section>
      <Glance cost={value} onSelect={select} />
      <div className="min-w-0 [grid-area:day]"><DayPanel resource={day} date={selected!} today={value.glance.today} typical={value.glance.typicalDay?.costUsd} /></div>
      <PeriodCards resource={period} range={range} onRange={setRange} />
    </div>
    <p className={cn(meta, "px-1 leading-relaxed")}>Dollar figures are the Claude SDK's estimate at API list prices. On a subscription you pay a flat fee, so read them as how much work was done, not as a bill. Before Sep 23 resumed sessions were over-counted (#389); those days are shown dashed and never compared.</p>
  </div>;
}

function CostSkeleton() {
  const block = "animate-pulse rounded-md bg-foreground/[0.05]";
  return <div className="grid grid-cols-[minmax(0,340px)_minmax(0,1fr)] items-start gap-4 max-[900px]:grid-cols-1" role="status" aria-label="Loading cost">
    <div className={cn(card, "px-6 py-5")}><div className={cn(block, "mb-5 h-3 w-24")} /><div className={cn(block, "aspect-[10/7] w-full")} /></div>
    <div className={cn(card, "px-6 py-6")}><div className={cn(block, "h-3 w-28")} /><div className={cn(block, "mt-3 h-7 w-64")} /><div className={cn(block, "mt-5 h-12 w-40")} /><div className={cn(block, "mt-8 h-[150px] w-full")} /></div>
  </div>;
}

/** The plan's 5-hour and 7-day quota from the newest sample in limits.ndjson; nothing without one. */
function QuotaBar({ limits }: { limits: WebCostLimits }) {
  const windows = quotaWindows(limits.windows);
  if (!windows.length) return null;
  const now = Date.now();
  const sampled = Date.parse(limits.sampledAt);
  return <section aria-label="Plan usage" className={cn(card, "flex flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3.5 max-[600px]:px-4")}>
    <p className="eyebrow shrink-0 max-[1100px]:w-full" title={Number.isFinite(sampled) ? `Sampled ${new Date(sampled).toLocaleString("en-US")}` : undefined}>Plan usage
      {Number.isFinite(sampled) && <span className="normal-case tracking-normal"> · as of {new Date(sampled).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}{now - sampled > 86_400_000 ? `, ${new Date(sampled).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</span>}</p>
    <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-8 gap-y-2.5 max-[1100px]:grid-cols-1">{windows.map(({ title, window }) => {
      const percent = Math.min(100, Math.max(0, window.percent!));
      const warn = percent >= 80 || window.status === "elevated" || window.status === "allowed_warning" || window.status === "rejected";
      const reset = resetsIn(window.resetsAt, now);
      return <div key={title} className="flex min-w-0 items-center gap-3">
        <span className="w-12 shrink-0 text-[13px]">{title}</span>
        <Progress max={100} value={percent} aria-label={`${title} usage`} className={cn("h-1.5 min-w-[60px] flex-1 bg-border", warn && "[&>[data-slot=progress-indicator]]:bg-warn")} />
        <span className={cn("shrink-0 text-[13px] tabular-nums", warn ? "font-medium text-warn" : "text-muted-foreground")}>{Math.round(percent)}%</span>
        {reset && <span className={cn(meta, "shrink-0 max-[600px]:hidden")}>{reset}</span>}
      </div>;
    })}</div>
  </section>;
}

function Glance({ cost, onSelect }: { cost: WebCost; onSelect: (date: string) => void }) {
  const { thisWeek, lastWeek, last30, typicalDay, busiestDay } = cost.glance;
  const recorded30 = cost.days.filter((d) => d.date >= last30.from && d.recorded).length;
  return <Section title="At a glance" aside={<><span className="min-[601px]:max-[900px]:hidden">API-equivalent</span><Est /></>} className="[grid-area:glance]">
    <div className="grid grid-cols-2 gap-x-4 gap-y-4">
      <Stat label="This week" value={usd(thisWeek.costUsd)} note={!thisWeek.comparable || !lastWeek.comparable ? "No fair comparison yet"
        : `${usd(lastWeek.costUsd)} the week before`} />
      <Stat label="30 days" value={usd(last30.costUsd)} note={!last30.comparable ? "includes over-counted days"
        : recorded30 > 0 && recorded30 < 30 ? `${recorded30} day${recorded30 === 1 ? "" : "s"} recorded` : `${usd(last30.costUsd / 30)} a day`} />
      <Stat label="Typical day" value={typicalDay ? usd(typicalDay.costUsd) : "—"} note={typicalDay ? `median, ${typicalDay.days} day${typicalDay.days === 1 ? "" : "s"}` : "no fair days yet"} />
      <Stat label="Busiest" value={busiestDay ? usd(busiestDay.costUsd) : "—"} note={busiestDay
        ? <button type="button" className="cursor-pointer underline decoration-primary/40 underline-offset-[3px] hover:decoration-primary" onClick={() => onSelect(busiestDay.date)}>{shortDay(busiestDay.date)}</button>
        : "no fair days yet"} />
    </div>
  </Section>;
}

function DayPanel({ resource, date, today, typical }: { resource: Resource<WebCost>; date: string; today: string; typical: number | undefined }) {
  const value = resource.state === "ready" && resource.value.from === date ? resource.value : undefined;
  const header = (body: ReactNode) => <section key={date} aria-label={longDay(date)} className={cn(card, "motion-enter min-w-0 px-6 py-6 max-[600px]:px-4 max-[600px]:py-5")}>
    <p className="eyebrow">{dayEyebrow(date, today)}</p>
    <h2 className="mt-1 mb-0 font-serif text-[24px] leading-tight font-normal tracking-[-0.3px]">{longDay(date)}</h2>
    {body}
  </section>;
  if (resource.state === "error") return header(<div className="mt-4"><Failed resource={resource} /></div>);
  if (!value) return header(<p className="mt-4 mb-0 text-sm text-muted-foreground" role="status">Loading…</p>);
  const info = value.days[0];
  const turns = value.totals.turns;
  const peak = busiestHour(value.hours);
  const note = !info?.recorded ? "Nothing was recorded this day: the usage ledger starts later."
    : info.overcounted ? "Over-counted: until the fix on Sep 23 (#389) a resumed session was charged its whole history, so this day is too high and is never compared."
    : turns === 0 ? "No turns this day." : undefined;
  const top = value.topTurns;
  const topShare = share(top.reduce((s, t) => s + t.costUsd, 0), value.totals.costUsd);
  return header(<>
    <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
      <p className="m-0 text-[48px] leading-none font-semibold tracking-[-0.03em] tabular-nums max-[600px]:text-[40px]" data-testid="day-cost">{usd(value.totals.costUsd)}<Est className="align-[12px]" /></p>
      <p className="m-0 max-w-[360px] pb-1 text-[13px] leading-snug text-muted-foreground">
        {note ?? <>{versusTypical(value.totals.costUsd, typical) && <span className="font-medium text-foreground">{versusTypical(value.totals.costUsd, typical)} · </span>}
          {turns} turn{turns === 1 ? "" : "s"}{peak !== undefined ? ` · busiest around ${hourLabel(peak)}` : ""}</>}</p>
    </div>
    {turns > 0 && <>
      <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2"><Legend items={CATEGORIES.map((c) => ({ label: c.label, color: c.color, hint: c.hint }))} /><span className={meta}>by hour</span></div>
      <Columns columns={value.hours.map((h) => ({ key: String(h.hour), label: String(h.hour), title: `${hourLabel(h.hour)}–${hourLabel(h.hour + 1)}`,
        parts: CATEGORIES.map((c) => h.byCategory[c.key]) }))} colors={CATEGORIES.map((c) => c.color)} names={CATEGORIES.map((c) => c.label)} labelEvery={(i) => i % 3 === 0} />
    </>}
    {top.length > 0 && <>
      <h3 className="eyebrow mt-7 mb-1">Where it went</h3>
      <ol className="m-0 list-none p-0" aria-label="Costliest turns">{top.map((turn) => {
        const category = categoryOf(turn.category);
        return <li key={`${turn.ts}:${turn.session.label}`} className="flex items-baseline gap-3 border-b py-2.5 last:border-b-0">
          <span className="w-[62px] shrink-0 text-[12px] tabular-nums text-muted-foreground">{clock(turn.ts, value.timeZone)}</span>
          <span className="mt-1 size-2 shrink-0 self-start rounded-[2px]" style={{ background: category.color }} title={category.label} />
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{turnTitle(turn)}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{turnMeta(turn)}</span></span>
          <span className="shrink-0 text-[13px] font-medium tabular-nums">{usd(turn.costUsd, true)}</span></li>;
      })}</ol>
      <p className={cn(meta, "mt-2 mb-0 leading-relaxed")}>{top.length === turns ? `All ${turns} turn${turns === 1 ? "" : "s"}.` : `The ${top.length} largest of ${turns} turns: ${topShare}% of the day.`} A turn's figure includes subagents that finished while it ran.</p>
    </>}
  </>);
}

/** A's "Who started it" and "Scheduled jobs", over the last 7 or 30 days. */
function PeriodCards({ resource, range, onRange }: { resource: Resource<WebCost>; range: Range; onRange: (range: Range) => void }) {
  const value = resource.state === "ready" ? resource.value : undefined;
  const toggle = <ToggleGroup type="single" value={range} onValueChange={(next) => next && onRange(next as Range)} variant="outline" size="sm" aria-label="Period" className="mb-1">
    <ToggleGroupItem value="7" className="h-7 px-2.5 text-[12px]">7 days</ToggleGroupItem>
    <ToggleGroupItem value="30" className="h-7 px-2.5 text-[12px]">30 days</ToggleGroupItem>
  </ToggleGroup>;
  const total = value?.totals.costUsd ?? 0;
  const overcounted = !!value && value.totals.overcountedCostUsd > 0;
  return <div className="min-w-0 space-y-4 [grid-area:range] max-[900px]:grid max-[900px]:grid-cols-2 max-[900px]:items-start max-[900px]:gap-4 max-[900px]:space-y-0 max-[600px]:grid-cols-1">
    <Section title="Who started it" aside={toggle}>
      {resource.state === "error" ? <Failed resource={resource} />
        : !value ? <p className="m-0 text-sm text-muted-foreground" role="status">Loading…</p>
        : !value.totals.turns ? <p className="m-0 text-[13px] text-muted-foreground">No turns in the last {range} days.</p>
        : <><Ranked label="Cost by who started it" rows={CATEGORIES.map((c) => ({ name: c.label, value: value.totals.byCategory[c.key], note: `${share(value.totals.byCategory[c.key], total)}%`, swatch: c.color, hint: c.hint }))} />
          <p className={cn(meta, "mt-4 mb-0 leading-relaxed")}>{value.totals.turns.toLocaleString("en-US")} turns. Background is heartbeats and turns that pick up finished subagents.{overcounted ? " Includes over-counted days." : ""}</p></>}
    </Section>
    {value && value.crons.length > 0 && <Section title="Scheduled jobs" aside={`last ${range} days`}>
      <Ranked label="Cost by scheduled job" color="var(--series-3)" rows={value.crons.slice(0, 6).map((cron) => ({ name: cron.name, value: cron.costUsd,
        note: `${cron.runs} run${cron.runs === 1 ? "" : "s"}${cron.runs > 1 ? ` · ${usd(cron.costUsd / cron.runs, true)} each` : ""}` }))} />
    </Section>}
  </div>;
}
