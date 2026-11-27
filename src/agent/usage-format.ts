import { joinText, ownerT, type Locale, type OwnerT, type OwnerText } from "../i18n/index.js";

/** One usage window as returned by the OAuth usage endpoint. */
interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}

interface ExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  currency?: string | null;
}

/** Scope a limit applies to — a specific model and/or surface, or null (all). */
interface UsageLimitScope {
  model?: { id?: string | null; display_name?: string | null } | null;
  surface?: string | null;
}

/**
 * One entry of the `limits` array — the authoritative per-window / per-model
 * usage cap. `kind` is open-ended (session / weekly_all / weekly_scoped and
 * possibly others), so we render any kind generically rather than dropping it.
 */
interface UsageLimit {
  kind?: string | null;
  group?: string | null;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  scope?: UsageLimitScope | null;
  is_active?: boolean | null;
}

export interface UsageResponse {
  /** Authoritative source of truth when present/non-empty. */
  limits?: UsageLimit[] | null;
  // Legacy top-level windows — fallback for older/other account shapes that
  // don't return `limits`. These miss scoped (per-model) caps.
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  extra_usage?: ExtraUsage | null;
}

/** Turn a parsed usage payload into the plain-text chat report. */
export function formatUsageReport(
  data: UsageResponse,
  now: number,
  subscriptionType?: string,
  gatewayActive?: boolean,
  locale?: Locale,
): OwnerText {
  const t = ownerT("usage", locale ?? "en");
  // Endpoint data is untrusted: a JSON body of literal `null`, or fields with
  // the wrong type (e.g. group: 7), must degrade gracefully rather than throw
  // out of the never-throws boundary. Coerce to a safe object up front and
  // normalize each field before any string/number method runs on it.
  const d: UsageResponse = data && typeof data === "object" ? data : {};

  const planLabel = subscriptionLabel(subscriptionType);
  const lines: OwnerText[] = [planLabel ? t("titlePlan", { plan: planLabel }) : t("title")];

  const limits = (Array.isArray(d.limits) ? d.limits : [])
    .map(toSafeLimit)
    .filter((l): l is SafeLimit => l !== null);
  if (limits.length > 0) {
    // Primary path: render every limit entry so nothing (esp. active scoped
    // caps like a Fable weekly wall) is silently dropped.
    lines.push(...renderLimits(t, limits, now, locale));
  } else {
    // Fallback for account shapes that don't return `limits`.
    lines.push(...windowLines(t, t("window.session"), d.five_hour, now, locale));
    lines.push(...windowLines(t, t("window.weekly"), d.seven_day, now, locale));
    const opus = windowLines(t, t("window.opus"), d.seven_day_opus, now, locale, true);
    if (opus.length > 0) lines.push(...opus);
    const sonnet = windowLines(t, t("window.sonnet"), d.seven_day_sonnet, now, locale, true);
    if (sonnet.length > 0) lines.push(...sonnet);
  }

  const extra = d.extra_usage;
  if (extra && typeof extra === "object" && extra.is_enabled === true) {
    const used = typeof extra.used_credits === "number" && Number.isFinite(extra.used_credits) ? extra.used_credits : 0;
    const limit = typeof extra.monthly_limit === "number" && Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : 0;
    const currency = typeof extra.currency === "string" && extra.currency && extra.currency !== "USD"
      ? `${extra.currency} `
      : "$";
    lines.push(t("extra", { used: `${currency}${used.toFixed(2)}`, limit: `${currency}${limit}` }));
  }

  if (gatewayActive) lines.push(t("gateway"));

  return joinText(lines);
}

/** One usage window as structured data (the web card's rows). */
export interface UsageWindowView {
  id: string;
  label: string;
  /** session = the 5-hour window, weekly = 7-day; scoped = per model/surface. */
  group: "session" | "weekly" | "other";
  scoped: boolean;
  /** The limit's kind as the endpoint names it ("session", "weekly_all", "weekly_scoped", …), so a
   *  client can word the window itself instead of showing the English `label`. */
  kind?: string;
  /** What a scoped window is scoped to (a model name, a surface), as data. */
  model?: string;
  surface?: string;
  /** 0–100, or null when the endpoint gave none. */
  percent: number | null;
  /** ms epoch, or null. */
  resetsAt: number | null;
  active: boolean;
  elevated: boolean;
}

/**
 * The same windows `/usage` prints, as data: the authoritative `limits` array
 * when present (sorted session → weekly → other), else the legacy top-level
 * windows. Untrusted input is narrowed per field, as in formatUsageReport.
 */
export function usageWindows(data: UsageResponse | null | undefined): UsageWindowView[] {
  const d: UsageResponse = data && typeof data === "object" ? data : {};
  const resets = (value: string | null | undefined) => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const limits = (Array.isArray(d.limits) ? d.limits : []).map(toSafeLimit).filter((l): l is SafeLimit => l !== null);
  if (limits.length > 0) {
    return [...limits].sort((a, b) => groupRank(a) - groupRank(b)).map((limit, index) => {
      const rank = groupRank(limit);
      return {
        id: `${limit.kind || "limit"}:${limit.modelName}:${limit.surface}:${index}`,
        label: limitLabel(limit),
        kind: limit.kind || undefined,
        ...(limit.modelName ? { model: limit.modelName } : {}),
        ...(limit.surface ? { surface: limit.surface } : {}),
        group: rank === 0 ? "session" : rank === 1 ? "weekly" : "other",
        scoped: !!(limit.modelName || limit.surface) || limit.kind.endsWith("_scoped"),
        percent: limit.percent,
        resetsAt: resets(limit.resetsAt),
        active: limit.isActive,
        elevated: isElevatedSeverity(limit.severity),
      };
    });
  }
  const legacy: Array<[string, string, UsageWindowView["group"], boolean, UsageWindow | null | undefined, string | undefined]> = [
    ["five_hour", "Session (5h)", "session", false, d.five_hour, undefined],
    ["seven_day", "Weekly (all)", "weekly", false, d.seven_day, undefined],
    ["seven_day_opus", "Weekly · Opus", "weekly", true, d.seven_day_opus, "Opus"],
    ["seven_day_sonnet", "Weekly · Sonnet", "weekly", true, d.seven_day_sonnet, "Sonnet"],
  ];
  return legacy.filter(([, , , , w]) => w && typeof w === "object").map(([id, label, group, scoped, w, model]) => ({
    id, label, group, scoped, kind: scoped ? "weekly_scoped" : group === "session" ? "session" : "weekly_all", ...(model ? { model } : {}),
    percent: typeof w!.utilization === "number" && Number.isFinite(w!.utilization) ? w!.utilization : null,
    resetsAt: resets(w!.resets_at), active: false, elevated: false,
  }));
}

/**
 * Render a labeled window as up to two lines:
 *   `<label> 36%`
 *   `  resets in 5d 23h  (Aug 2, 7:59 AM)`
 * Returns an empty array for a null/absent window (used to omit per-model rows).
 * When `compact` is set, the two lines are joined so per-model rows stay tight.
 */
function windowLines(t: OwnerT<"usage">, label: string, window: UsageWindow | null | undefined, now: number, locale: Locale | undefined, compact = false): OwnerText[] {
  if (!window || typeof window !== "object") return [];
  const percent = typeof window.utilization === "number" && Number.isFinite(window.utilization)
    ? `${Math.round(window.utilization)}%`
    : t("noPercent");
  const reset = typeof window.resets_at === "string" ? formatReset(window.resets_at, now, locale) : null;
  // The legacy labels share one column; compact rows (per model) are indented under the weekly one.
  const column = (compact ? `  ${label}` : label).padEnd(14);

  if (compact) {
    return [reset ? t("windowLineReset", { label: column, percent, countdown: reset.countdown, clock: reset.clock }) : t("windowLine", { label: column, percent })];
  }

  const out = [t("windowLine", { label: column, percent })];
  if (reset) out.push(t("resetLine", { countdown: reset.countdown, clock: reset.clock }));
  return out;
}

/**
 * A limit entry with every field narrowed to a safe, already-typed value, so
 * the render helpers below never call a string/number method on untrusted data.
 */
interface SafeLimit {
  kind: string;
  group: string;
  percent: number | null;
  severity: string;
  resetsAt: string | null;
  modelName: string;
  surface: string;
  isActive: boolean;
}

/**
 * Normalize one raw `limits` entry into a SafeLimit, coercing every field with
 * a typeof check. Returns null for a non-object entry (dropped by the caller).
 */
function toSafeLimit(raw: unknown): SafeLimit | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const scope = l.scope && typeof l.scope === "object" ? l.scope as Record<string, unknown> : undefined;
  const model = scope?.model && typeof scope.model === "object" ? scope.model as Record<string, unknown> : undefined;
  return {
    kind: typeof l.kind === "string" ? l.kind : "",
    group: typeof l.group === "string" ? l.group : "",
    percent: typeof l.percent === "number" && Number.isFinite(l.percent) ? l.percent : null,
    severity: typeof l.severity === "string" ? l.severity : "",
    resetsAt: typeof l.resets_at === "string" ? l.resets_at : null,
    modelName: typeof model?.display_name === "string" ? model.display_name.trim() : "",
    surface: typeof scope?.surface === "string" ? scope.surface.trim() : "",
    isActive: l.is_active === true,
  };
}

/**
 * Render the `limits` array, one line per entry, grouped session-then-weekly
 * (then anything else), with the label column padded so percents align.
 */
function renderLimits(t: OwnerT<"usage">, limits: SafeLimit[], now: number, locale: Locale | undefined): OwnerText[] {
  // Stable sort (V8 Array.sort is stable): session group first, weekly next,
  // unknown groups last — original order preserved within each group.
  const sorted = [...limits].sort((a, b) => groupRank(a) - groupRank(b));
  const labels = sorted.map((limit) => limitLabel(limit, locale));
  const colWidth = Math.max(...labels.map((l) => l.length + 1)) + 2; // +1 colon, +2 gap
  return sorted.map((limit, i) => renderLimitLine(t, limit, labels[i], colWidth, now, locale));
}

/** Rank a limit's group for ordering: session (0), weekly (1), other (2). */
function groupRank(limit: SafeLimit): number {
  const group = limit.group.toLowerCase();
  const kind = limit.kind.toLowerCase();
  if (group === "session" || kind.startsWith("session")) return 0;
  if (group === "weekly" || kind.includes("weekly")) return 1;
  return 2;
}

/** Build a human label from a limit's kind + scope (e.g. "Weekly · Fable"). */
function limitLabel(limit: SafeLimit, locale?: Locale): string {
  const t = ownerT("usage", locale ?? "en");
  let base: string;
  switch (limit.kind) {
    case "session": base = t("limit.session"); break;
    case "weekly_all": base = t("limit.weeklyAll"); break;
    case "weekly_scoped": base = t("limit.weekly"); break;
    default: base = prettifyKind(limit.kind) ?? t("limit.fallback");
  }
  const parts = [base];
  if (limit.modelName) parts.push(limit.modelName);
  if (limit.surface) parts.push(limit.surface);
  return parts.join(" · ");
}

/** Turn an unknown kind like "five_hour_scoped" into "Five Hour Scoped". */
function prettifyKind(kind: string): string | undefined {
  const words = kind.split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * One rendered limit line:
 *   `Weekly · Fable:      43%  ← active · resets in 5d 16h (Aug 2, 7:59 AM)`
 * Elevated severity prefixes the line with ⚠️.
 */
function renderLimitLine(t: OwnerT<"usage">, limit: SafeLimit, label: string, colWidth: number, now: number, locale: Locale | undefined): OwnerText {
  const pct = limit.percent !== null ? `${Math.round(limit.percent)}%` : t("noPercent");
  const reset = limit.resetsAt ? formatReset(limit.resetsAt, now, locale) : null;

  const line = {
    column: `${label}:`.padEnd(colWidth) + pct.padEnd(5),
    active: limit.isActive ? t("active") : "",
    resets: reset ? t("resetsIn", { countdown: reset.countdown, clock: reset.clock }) : "",
  };
  // The trailing pad goes when nothing follows it.
  if (!line.resets && line.active) line.active = line.active.trimEnd();
  else if (!line.resets) line.column = line.column.trimEnd();
  return isElevatedSeverity(limit.severity) ? t("limitLineElevated", line) : t("limitLine", line);
}

/** Any severity other than normal/none is treated as elevated (⚠️). */
function isElevatedSeverity(severity: string): boolean {
  if (!severity) return false;
  const s = severity.toLowerCase();
  return s !== "normal" && s !== "none" && s !== "ok";
}

/** Format an ISO reset timestamp into a human countdown + local clock time. */
/** `locale` undefined (unset): English, and the system's own clock format. */
export function formatReset(resetsAt: string, now: number, locale?: Locale): { countdown: string; clock: string } {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) {
    const unknown = ownerT("usage", locale ?? "en")("countdown.unknown");
    return { countdown: unknown, clock: unknown };
  }
  return { countdown: formatCountdown(resetMs - now, locale), clock: formatLocalClock(resetMs, now, locale) };
}

/** "5d 23h" / "5h 12m" / "47m" / "now". Two coarsest non-zero units. */
export function formatCountdown(ms: number, locale?: Locale): string {
  const t = ownerT("usage", locale ?? "en");
  if (ms <= 0) return t("countdown.now");
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return t("countdown.daysHours", { d: days, h: hours });
  if (hours > 0) return t("countdown.hoursMinutes", { h: hours, m: minutes });
  return t("countdown.minutes", { m: minutes });
}

/**
 * Local-zone clock for a reset instant. Shows the date when it is not today,
 * e.g. "7:59 PM" (today) vs "Aug 2, 7:59 AM" (another day).
 */
function formatLocalClock(resetMs: number, now: number, locale: Locale | undefined): string {
  const reset = new Date(resetMs);
  // Unset (undefined): the system's own conventions, as before.
  const time = reset.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === reset.toDateString();
  if (sameDay) return time;
  const date = reset.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return ownerT("usage", locale ?? "en")("dateTime", { date, time });
}

export function subscriptionLabel(subscriptionType?: string): string {
  if (!subscriptionType) return "";
  const map: Record<string, string> = {
    max: "Max",
    max_5x: "Max 5x",
    max_20x: "Max 20x",
    pro: "Pro",
    team: "Team",
    enterprise: "Enterprise",
  };
  return map[subscriptionType] ?? subscriptionType;
}
