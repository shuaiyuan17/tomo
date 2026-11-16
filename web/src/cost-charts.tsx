/* Chart pieces of the Study's Cost page: plain CSS, no chart library. Colours come from `.viz` in styles.css. */
import { useState, type ReactNode } from "react";
import type { WebCostDay } from "../../src/web/protocol.js";
import { cn } from "@/lib/utils";
import { bin, calendarWeeks, longDay, monthOf, niceMax, shortDay, usd } from "./cost.js";

export const card = "rounded-xl border bg-card shadow-xs";
export const meta = "text-[11px] tracking-[0.02em] text-muted-foreground";
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

export function Section({ title, aside, children, className, label }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return <section aria-label={label ?? title} className={cn(card, "min-w-0 px-6 py-5 max-[600px]:px-4 max-[600px]:py-4", className)}>
    <div className="mb-4 flex items-baseline justify-between gap-3"><h2 className="eyebrow shrink-0 whitespace-nowrap">{title}</h2>{aside && <div className={cn(meta, "text-right")}>{aside}</div>}</div>
    {children}
  </section>;
}

/** "EST.": every dollar figure on the page is an estimate at API list prices, never a bill. */
export function Est({ className }: { className?: string }) {
  return <span title="Estimated at API list prices by the Claude SDK. On a subscription this is not what you pay."
    className={cn("ml-1.5 rounded-[5px] border px-1 py-px align-middle font-sans text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase", className)}>est.</span>;
}

export function Legend({ items }: { items: { label: string; color: string; hint?: string }[] }) {
  return <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">{items.map((item) =>
    <li key={item.label} title={item.hint} className="flex items-center gap-1.5 text-[12px] text-muted-foreground"><span className="size-2.5 rounded-[3px]" style={{ background: item.color }} />{item.label}</li>)}</ul>;
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="min-w-0"><p className={cn(meta, "m-0")}>{label}</p>
    <p className="m-0 mt-0.5 text-[20px] leading-tight font-semibold tracking-[-0.01em] tabular-nums">{value}</p>
    {note && <p className="m-0 mt-0.5 text-[12px] text-muted-foreground">{note}</p>}</div>;
}

export interface Column { key: string; label: string; title: string; parts: number[] }
const lastPart = (parts: number[]) => { let last = 0; parts.forEach((p, i) => { if (p > 0) last = i; }); return last; };
/**
 * Stacked columns: one baseline, 2px surface gaps between segments, a rounded
 * top, hairline grid, and a tooltip on hover and keyboard focus listing every series.
 */
export function Columns({ columns, colors, names, height = 150, format = usd, labelEvery }: { columns: Column[]; colors: string[]; names: string[]; height?: number;
  format?: (v: number) => string; labelEvery?: (index: number) => boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const scale = niceMax(Math.max(0, ...columns.map((c) => sum(c.parts))));
  const lines = [0, scale / 2, scale];
  const active = hover != null ? columns[hover] : null;
  return <div className="relative" role="group" aria-label="Cost by hour">
    <div className="relative ml-9" style={{ height }}>
      {lines.map((value) => <div key={value} className="absolute right-0 -left-9 flex items-center" style={{ bottom: `${(value / scale) * 100}%`, transform: "translateY(50%)" }}>
        <span className="w-8 pr-1.5 text-right text-[10.5px] tabular-nums text-muted-foreground">{format(value)}</span>
        <span className="h-px flex-1" style={{ background: value === 0 ? "var(--axis)" : "var(--grid)" }} /></div>)}
      <div className="absolute inset-0 flex items-end gap-[2px]" onPointerLeave={() => setHover(null)}>
        {columns.map((column, index) => {
          const total = sum(column.parts);
          return <div key={column.key} data-col tabIndex={0} role="img" aria-label={`${column.title}: ${format(total)}`}
            onPointerEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(null)}
            className="relative flex h-full min-w-0 flex-1 flex-col-reverse items-center rounded-sm outline-offset-1">
            {hover === index && <span className="absolute inset-x-[-1px] inset-y-0 rounded-sm bg-foreground/[0.05]" />}
            {column.parts.map((part, i) => part > 0 && <span key={i} className={cn("bar vgrow relative w-full max-w-[24px] shrink-0", i === lastPart(column.parts) && "rounded-t-[4px]")}
              style={{ height: `calc(${(part / scale) * 100}% - ${i > 0 ? 2 : 0}px)`, marginBottom: i > 0 ? 2 : 0, minHeight: 1, animationDelay: `${index * 8}ms`, background: colors[i] }} />)}
          </div>;
        })}
      </div>
      {active && hover != null && <div role="status" className="pointer-events-none absolute z-10 min-w-[150px] rounded-lg border bg-popover px-3 py-2 shadow-md"
        style={{ bottom: `min(${(sum(active.parts) / scale) * 100}% + 8px, 100% - 60px)`, ...(hover / columns.length > 0.5 ? { right: `${(1 - hover / columns.length) * 100}%` } : { left: `${((hover + 1) / columns.length) * 100}%` }) }}>
        <p className="m-0 text-[11px] text-muted-foreground">{active.title}</p>
        <p className="m-0 text-[15px] font-semibold tabular-nums">{format(sum(active.parts))}</p>
        {names.length > 1 && <ul className="m-0 mt-1 list-none space-y-0.5 p-0">{names.map((name, i) => <li key={name} className="flex items-center gap-2 text-[12px]">
          <span className="h-[2px] w-3 rounded-full" style={{ background: colors[i] }} /><span className="tabular-nums">{format(active.parts[i] ?? 0)}</span><span className="text-muted-foreground">{name}</span></li>)}</ul>}
      </div>}
    </div>
    <div className="mt-1.5 ml-9 flex gap-[2px]" aria-hidden="true">{columns.map((column, index) => <span key={column.key} className="relative h-4 min-w-0 flex-1">
      {(labelEvery ? labelEvery(index) : true) && <span className="absolute left-1/2 -translate-x-1/2 text-[10.5px] whitespace-nowrap tabular-nums text-muted-foreground">{column.label}</span>}</span>)}</div>
  </div>;
}

/** Ranked horizontal bars, largest first: name, bar and figure per row. */
export function Ranked({ rows, color = "var(--series-1)", format = usd, label }: { rows: { name: string; value: number; note?: string; swatch?: string; hint?: string }[]; color?: string; format?: (v: number) => string; label?: string }) {
  const top = Math.max(...rows.map((r) => r.value), 1e-9);
  return <ul aria-label={label} className="m-0 list-none space-y-3 p-0">{rows.map((row, index) => <li key={row.name} title={row.hint ?? `${row.name}: ${format(row.value)}`}>
    <div className="mb-1 flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate text-[13px]">{row.name}{row.note && <span className="ml-2 text-[11px] text-muted-foreground">{row.note}</span>}</span>
      <span className="shrink-0 text-[13px] tabular-nums">{format(row.value)}</span></div>
    <div className="h-1.5 rounded-full bg-foreground/[0.06]"><div className="growx h-full rounded-full" style={{ width: `${row.value > 0 ? Math.max(0.6, (row.value / top) * 100) : 0}%`, background: row.swatch ?? color, animationDelay: `${index * 30}ms` }} /></div>
  </li>)}</ul>;
}

const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const OVERCOUNTED = "border border-dashed border-muted-foreground/50";
function dayTitle(day: WebCostDay): string {
  if (!day.recorded) return `${shortDay(day.date)}: nothing recorded`;
  return `${shortDay(day.date)}: ${usd(day.costUsd)}${day.overcounted ? " (over-counted, before the Sep 23 fix)" : ""}`;
}

/**
 * Ten weeks, Monday to Sunday, ending with `today`'s week. A day before the
 * ledger started is a faint, unpickable cell; an over-counted one a dashed box.
 */
export function Heatmap({ days, today, selected, onSelect }: { days: readonly WebCostDay[]; today: string; selected: string; onSelect: (date: string) => void }) {
  const weeks = calendarWeeks(days, today);
  return <div>
    <div className="flex gap-[3px]">
      <div className="mr-1 flex flex-col gap-[3px] pt-[18px]" aria-hidden="true">{WEEKDAYS.map((name, i) => <span key={i} className="flex flex-1 items-center text-[10px] text-muted-foreground">{name}</span>)}</div>
      {weeks.map((week, index) => {
        const first = week.find(Boolean);
        const startsMonth = first && (Number(first.date.slice(8)) <= 7 || index === 0);
        return <div key={index} className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="h-[15px] text-[10px] text-muted-foreground" aria-hidden="true">{startsMonth ? monthOf(first.date) : ""}</span>
          {week.map((day, weekday) => !day ? <span key={weekday} className="aspect-square w-full" />
            : !day.recorded ? <span key={weekday} title={dayTitle(day)} data-day={day.date} className="aspect-square w-full rounded-[4px] bg-foreground/[0.035]" />
            : <button key={weekday} type="button" data-day={day.date} onClick={() => onSelect(day.date)} aria-pressed={selected === day.date}
              title={dayTitle(day)} aria-label={`${longDay(day.date)}: ${usd(day.costUsd)}${day.overcounted ? ", over-counted" : ""}`}
              className={cn("aspect-square w-full cursor-pointer rounded-[4px] transition-transform outline-offset-2 hover:scale-110", selected === day.date && "ring-2 ring-foreground ring-offset-2 ring-offset-card", day.overcounted && OVERCOUNTED)}
              style={{ background: day.overcounted ? "transparent" : `var(--seq-${bin(day.costUsd)})` }} />)}
        </div>;
      })}
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2" aria-hidden="true">
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">$0{[0, 1, 2, 3, 4, 5].map((step) => <span key={step} className="size-3 rounded-[3px]" style={{ background: `var(--seq-${step})` }} />)}$200+</span>
    </div>
    {days.some((d) => d.overcounted) && <p className="m-0 mt-2 flex items-center gap-1.5 text-[10.5px] text-muted-foreground"><span className={cn("size-3 shrink-0 rounded-[3px]", OVERCOUNTED)} />over-counted (before #389)</p>}
  </div>;
}
