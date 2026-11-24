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

/** The account-wide 5-hour window of a sample, if it has one with a reading. */
function sessionWindow(sample: LimitSample): LimitWindowSample | undefined {
  return sample.windows.find((w) => typeof w.percent === "number" && Number.isFinite(w.percent)
    && (sample.source === "oauth-usage" ? w.group === "session" && !w.scoped : w.window === "five_hour"));
}

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
  for (const sample of readTailSamples(path)) {
    const window = sessionWindow(sample);
    if (!window) {
      if (sample.source === "oauth-usage") return 0;
      continue;
    }
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    const sampledAt = Date.parse(sample.ts);
    if ((Number.isFinite(resetsAt) && resetsAt <= now) || (Number.isFinite(sampledAt) && now - sampledAt >= FIVE_HOURS_MS)) return 0;
    return window.percent;
  }
  return undefined;
}
