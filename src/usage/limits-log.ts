import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SdkSignal } from "../agent/sdk-signals.js";
import { usageWindows, type UsageResponse } from "../agent/usage.js";
import { log } from "../logger.js";
import { appendLineSerial } from "./append.js";
import { usageDataDir } from "./dir.js";
import { errorMessage } from "../error-text.js";

/** Bump when a line's shape changes incompatibly. */
export const LIMITS_LOG_VERSION = 1;
/** An unchanged sample is written again at most this often. */
export const LIMITS_REPEAT_MS = 10 * 60_000;

export type LimitSource = "oauth-usage" | "rate-limit-event";

/** One quota window in a sample. Fields the source did not give are left out. */
export interface LimitWindowSample {
  /** oauth-usage: `kind:model:surface` (or the legacy key, e.g. `five_hour`); rate-limit-event: `rateLimitType`. */
  window: string;
  label?: string;
  /** session = 5-hour, weekly = 7-day. */
  group?: "session" | "weekly" | "other";
  /** Per-model / per-surface cap. */
  scoped?: boolean;
  /** 0–100, unrounded. */
  percent?: number;
  /** rate-limit-event only: the SDK's `utilization` exactly as sent (usually a 0–1 fraction). */
  utilization?: number;
  /** ISO time. */
  resetsAt?: string;
  /** oauth-usage: `elevated` / `normal`; rate-limit-event: `allowed` / `allowed_warning` / `rejected`. */
  status?: string;
  active?: boolean;
  overage?: boolean;
}

/** One line of `limits.ndjson`. */
export interface LimitSample {
  v: number;
  ts: string;
  source: LimitSource;
  windows: LimitWindowSample[];
}

const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** The windows of an `/api/oauth/usage` body, as samples (same reading as the Plan usage card). */
export function oauthWindows(data: UsageResponse | null | undefined): LimitWindowSample[] {
  return usageWindows(data).map((w) => defined({
    // The view's id ends in a sort index, which is not part of the window's identity.
    window: w.id.replace(/:\d+$/, "").replace(/:+$/, ""),
    label: w.label,
    group: w.group,
    scoped: w.scoped,
    percent: w.percent ?? undefined,
    resetsAt: iso(w.resetsAt),
    status: w.elevated ? "elevated" : "normal",
    active: w.active,
  }));
}

/** The window of an SDK `rate_limit_event` (already parsed by sdk-signals.ts). */
export function rateLimitWindow(signal: Extract<SdkSignal, { kind: "rate_limit" }>): LimitWindowSample {
  return defined({
    window: signal.limit ?? "unknown",
    // Unrounded: the display rounding in sdk-signals.ts would merge 0.901 and 0.904.
    percent: signal.rawUtilization === undefined ? signal.utilization
      : signal.rawUtilization <= 1 ? Math.round(signal.rawUtilization * 1e6) / 1e4 : signal.rawUtilization,
    utilization: signal.rawUtilization,
    resetsAt: iso(signal.resetsAt),
    status: signal.status,
    overage: signal.overage,
  });
}

/**
 * Append-only quota history at `~/.tomo/data/usage/limits.ndjson`: one line
 * per `/api/oauth/usage` read and per SDK `rate_limit_event`. Only records —
 * nothing reads it yet. A sample identical to the last one written for the
 * same stream (oauth-usage, or one rate-limit type) within LIMITS_REPEAT_MS is
 * skipped, so a polling page or a chatty turn does not grow the file. Never
 * throws: a failed write is a warn in the log and the caller carries on.
 */
export class LimitsLog {
  readonly path: string;
  private last = new Map<string, { key: string; at: number }>();

  constructor(tomoHome: string, private readonly now: () => number = Date.now) {
    this.path = join(usageDataDir(tomoHome), "limits.ndjson");
  }

  recordOAuthUsage(data: UsageResponse | null | undefined): Promise<void> {
    try {
      const windows = oauthWindows(data);
      if (windows.length === 0) return Promise.resolve();
      return this.record("oauth-usage", "oauth-usage", windows);
    } catch (err) {
      return this.warn(err);
    }
  }

  recordSignal(signal: SdkSignal): Promise<void> {
    if (signal.kind !== "rate_limit") return Promise.resolve();
    try {
      const window = rateLimitWindow(signal);
      return this.record("rate-limit-event", `rate-limit-event:${window.window}`, [window]);
    } catch (err) {
      return this.warn(err);
    }
  }

  private async record(source: LimitSource, stream: string, windows: LimitWindowSample[]): Promise<void> {
    const now = this.now();
    const key = JSON.stringify(windows);
    try {
      // Serialized per file, and the dedup decision is made at write time against
      // what actually landed: so the last line and `last` always agree, and a
      // failed write leaves `last` alone (the next sample is not skipped).
      await appendLineSerial(this.path, () => {
        const previous = this.last.get(stream);
        if (previous && previous.key === key && now - previous.at < LIMITS_REPEAT_MS) return undefined;
        const sample: LimitSample = { v: LIMITS_LOG_VERSION, ts: new Date(now).toISOString(), source, windows };
        return JSON.stringify(sample);
      }, () => this.last.set(stream, { key, at: now }));
    } catch (err) {
      await this.warn(err);
    }
  }

  private async warn(err: unknown): Promise<void> {
    log.warn({ err: errorMessage(err), path: this.path }, "Could not record a usage-limit sample");
  }
}

const shared = new Map<string, LimitsLog>();
/** One log per tomo home, so `/usage` and the web card share the dedup state. */
export function limitsLogFor(tomoHome: string): LimitsLog {
  let existing = shared.get(tomoHome);
  if (!existing) shared.set(tomoHome, existing = new LimitsLog(tomoHome));
  return existing;
}

/** How much of the end of `limits.ndjson` the latest-sample lookup reads. */
const LIMITS_TAIL_BYTES = 256 * 1024;

/**
 * The newest quota sample, for the Cost page's quota bar: the last
 * `oauth-usage` line (all windows at once) in the file's tail, or failing
 * that the last line of any source. Torn or foreign lines are skipped;
 * undefined when there is none or the file cannot be read.
 */
export function readLatestLimitSample(path: string): LimitSample | undefined {
  let samples: LimitSample[];
  try {
    samples = readTailSamples(path);
  } catch {
    return undefined;
  }
  let fallback: LimitSample | undefined;
  for (const sample of samples) {
    if (sample.source === "oauth-usage") return sample;
    fallback ??= sample;
  }
  return fallback;
}

/** The well-formed samples in the file's tail, newest first. [] for no file; throws when it cannot be read. */
function readTailSamples(path: string): LimitSample[] {
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LIMITS_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    text = buffer.toString("utf8", 0, read);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const out: LimitSample[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let sample: LimitSample;
    try { sample = JSON.parse(lines[i]) as LimitSample; } catch { continue; }
    if (!sample || typeof sample.ts !== "string" || !Array.isArray(sample.windows)) continue;
    out.push(sample);
  }
  return out;
}

const FIVE_HOURS_MS = 5 * 60 * 60_000;

/** The account-wide 5-hour window of a sample, if it has one (with a reading or not). */
function sessionWindow(sample: LimitSample): LimitWindowSample | undefined {
  return sample.windows.find((w) => (sample.source === "oauth-usage" ? w.group === "session" && !w.scoped : w.window === "five_hour"));
}

/** The account-wide weekly window of a sample (all models), if it has one (with a reading or not). */
function weeklyWindow(sample: LimitSample): LimitWindowSample | undefined {
  return sample.windows.find((w) => (sample.source === "oauth-usage" ? w.group === "weekly" && !w.scoped : w.window === "seven_day"));
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

/**
 * The share of the 5-hour window used (0–100), from the newest sample that
 * speaks for it: an SDK rate_limit_event with a five_hour reading, or any
 * `/api/oauth/usage` read (all windows at once: one with no 5-hour window
 * says there is none in force, read as 0). A window that has reset since
 * (its `resetsAt` is past, or the sample is older than five hours) reads 0.
 * Undefined when no sample speaks for it (no file, API-key auth). Throws
 * when the file exists but cannot be read.
 */
export function readSessionWindowPercent(path: string, now = Date.now()): number | undefined {
  return windowPercent(readTailSamples(path), sessionWindow, FIVE_HOURS_MS, now);
}

/**
 * The same for the account-wide weekly window (all models): the newest
 * sample that speaks for it, 0 once it has reset (`resetsAt` past, or the
 * sample a week old), 0 when the newest usage read has no weekly window. Within its week the share only grows, so an older reading
 * still holds as a floor: it is not dropped for age alone.
 */
export function readWeeklyWindowPercent(path: string, now = Date.now()): number | undefined {
  return windowPercent(readTailSamples(path), weeklyWindow, SEVEN_DAYS_MS, now);
}

/** Samples older than this do not count for the gate at all (see readQuotaGateReading). */
export const QUOTA_GATE_SAMPLE_MAX_AGE_MS = 6 * 60 * 60_000;
/** A usage read that has not settled by then counts as failed: the next one may start. */
export const QUOTA_REFRESH_TIMEOUT_MS = 60_000;

export type QuotaGateWindow = "five_hour" | "weekly";
/** `resetsAt` (ms epoch): when that window next resets, when its sample said so. */
export interface QuotaGateReading { window: QuotaGateWindow; percent: number; resetsAt?: number }

/**
 * What the sub-session quota gate reads: the higher of the 5-hour and the
 * weekly window's share used (one read of the file). An account that has no
 * 5-hour window (the oauth read carries only weekly ones) is gated on the
 * week alone; one with both stops at whichever fills first. Undefined when
 * neither window is known (no samples, API-key auth). Throws when the file
 * exists but cannot be read.
 */
export function readQuotaGateReading(path: string, now = Date.now()): QuotaGateReading | undefined {
  // Only recent samples speak: an old one may be from another login (a
  // switch to API-key auth leaves the last subscription reading behind),
  // and with none recent the gate holds nothing.
  const samples = readTailSamples(path).filter((s) => {
    const at = Date.parse(s.ts);
    return Number.isFinite(at) && now - at < QUOTA_GATE_SAMPLE_MAX_AGE_MS;
  });
  const session = windowReading(samples, sessionWindow, FIVE_HOURS_MS, now);
  const weekly = windowReading(samples, weeklyWindow, SEVEN_DAYS_MS, now);
  if (session === undefined && weekly === undefined) return undefined;
  if (weekly !== undefined && (session === undefined || weekly.percent > session.percent)) return { window: "weekly", ...weekly };
  return { window: "five_hour", ...session! };
}

/**
 * When the newest COMPLETE `/api/oauth/usage` sample in the file's tail was
 * taken (ms epoch): one whose account-wide windows (5-hour, weekly all
 * models) all carry a reading. A read that left one out says nothing new
 * about it, so it does not count as fresh. Undefined: none, or unreadable.
 */
export function newestOAuthSampleAt(path: string): number | undefined {
  try {
    for (const sample of readTailSamples(path)) {
      if (sample.source !== "oauth-usage") continue;
      const gated = sample.windows.filter((w) => !w.scoped && (w.group === "session" || w.group === "weekly"));
      if (!gated.every((w) => typeof w.percent === "number" && Number.isFinite(w.percent))) continue;
      const at = Date.parse(sample.ts);
      return Number.isFinite(at) ? at : undefined;
    }
  } catch { /* unreadable: no sample known */ }
  return undefined;
}

/** The gate's samples are this old before it asks for a fresh usage read. */
export const QUOTA_SAMPLE_MAX_AGE_MS = 30 * 60_000;
/** At most one such read this often, whether or not the last one worked. */
export const QUOTA_REFRESH_MIN_INTERVAL_MS = 30 * 60_000;

/** How long a task's own turn waits for a fresh usage read before the gate decides on what it has. */
export const QUOTA_REFRESH_WAIT_MS = 15_000;

/**
 * The quota gate's reading, kept current. Usage reads (`/api/oauth/usage`)
 * are otherwise only taken when the owner opens `/usage` or the web usage
 * card, and the SDK's rate-limit events rarely carry the weekly share, so a
 * daemon left alone would gate unattended tasks on an ever older reading.
 *
 * `ensureFresh` is awaited before a task's own turn is gated: when the newest
 * complete usage read is older than QUOTA_SAMPLE_MAX_AGE_MS it takes one (or
 * joins the one in flight) and waits for it, at most QUOTA_REFRESH_WAIT_MS;
 * reads are throttled to one per QUOTA_REFRESH_MIN_INTERVAL_MS whether they
 * worked or not, so a failing read (no token) costs the wait once, not every
 * turn. Then `read` answers from the file, synchronously. When no read can be
 * had the gate decides on the newest reading it has (a weekly share is a
 * floor within its week), and with none at all (API-key auth) holds nothing.
 */
export class QuotaGateReader {
  private inFlight: Promise<void> | undefined;
  private lastAttempt = -Infinity;
  private staleWarned = false;
  private refresh: (() => Promise<unknown>) | undefined;

  constructor(private readonly opts: { path: string; refresh?: () => Promise<unknown>; now?: () => number }) {
    this.refresh = opts.refresh;
  }

  /** The usage read to take when the samples are stale; none: the gate reads the file only. */
  setRefresh(refresh: () => Promise<unknown>): void {
    this.refresh = refresh;
  }

  /** As readQuotaGateReading (throws when the file cannot be read). */
  read(): QuotaGateReading | undefined {
    const now = (this.opts.now ?? Date.now)();
    const reading = readQuotaGateReading(this.opts.path, now);
    // Samples there, none recent: say so once per stretch (the gate is open).
    if (!reading && readTailSamples(this.opts.path).length > 0) {
      if (!this.staleWarned) log.warn({ maxAgeHours: QUOTA_GATE_SAMPLE_MAX_AGE_MS / 3_600_000 }, "No recent usage reading; sub-session turns are not held for quota");
      this.staleWarned = true;
    } else {
      this.staleWarned = false;
    }
    return reading;
  }

  /** A fresh usage read in the file when one is due, waited for up to `waitMs`. Never throws. */
  async ensureFresh(waitMs = QUOTA_REFRESH_WAIT_MS): Promise<void> {
    const pending = this.start();
    if (!pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  /** The read in flight, a new one when due, or undefined when the samples are fresh enough or a read is throttled. */
  private start(): Promise<void> | undefined {
    if (this.inFlight) return this.inFlight;
    const refresh = this.refresh;
    const now = (this.opts.now ?? Date.now)();
    if (!refresh || now - this.lastAttempt < QUOTA_REFRESH_MIN_INTERVAL_MS) return undefined;
    const newest = newestOAuthSampleAt(this.opts.path);
    if (newest !== undefined && now - newest < QUOTA_SAMPLE_MAX_AGE_MS) return undefined;
    this.lastAttempt = now;
    let pending: Promise<unknown>;
    try {
      pending = refresh();
    } catch (err) {
      pending = Promise.reject(err);
    }
    // A read that never settles must not hold every later one: past the timeout it counts as failed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${QUOTA_REFRESH_TIMEOUT_MS / 1000}s`)), QUOTA_REFRESH_TIMEOUT_MS);
      timer.unref?.();
    });
    const settled = Promise.race([pending, timeout])
      .then(() => undefined, (err) => { log.warn({ err: errorMessage(err) }, "Could not refresh the usage reading for the sub-session quota gate"); })
      .finally(() => { clearTimeout(timer); if (this.inFlight === settled) this.inFlight = undefined; });
    this.inFlight = settled;
    return settled;
  }
}

function windowPercent(
  samples: readonly LimitSample[],
  pick: (sample: LimitSample) => LimitWindowSample | undefined,
  spanMs: number,
  now: number,
): number | undefined {
  return windowReading(samples, pick, spanMs, now)?.percent;
}

/** A window's share used and, when its sample gives one, its reset time. */
function windowReading(
  samples: readonly LimitSample[],
  pick: (sample: LimitSample) => LimitWindowSample | undefined,
  spanMs: number,
  now: number,
): { percent: number; resetsAt?: number } | undefined {
  for (const sample of samples) {
    const window = pick(sample);
    if (!window) {
      // A usage read lists every window in force: one it lacks is not in force.
      if (sample.source === "oauth-usage") return { percent: 0 };
      continue;
    }
    // The window is there but this sample has no reading of it: it says nothing
    // about how full it is, so an older reading still stands.
    if (typeof window.percent !== "number" || !Number.isFinite(window.percent)) continue;
    // Past its reset, or older than the window is long (so it has reset since): nothing used yet.
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    const sampledAt = Date.parse(sample.ts);
    if ((Number.isFinite(resetsAt) && resetsAt <= now) || (Number.isFinite(sampledAt) && now - sampledAt >= spanMs)) return { percent: 0 };
    return { percent: window.percent, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) };
  }
  return undefined;
}
