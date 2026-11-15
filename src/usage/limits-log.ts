import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SdkSignal } from "../agent/sdk-signals.js";
import { usageWindows, type UsageResponse } from "../agent/usage.js";
import { log } from "../logger.js";
import { usageDataDir } from "./dir.js";

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
  /** 0–100. */
  percent?: number;
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
    percent: signal.utilization,
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
  readonly dir: string;
  readonly path: string;
  private last = new Map<string, { key: string; at: number }>();

  constructor(tomoHome: string, private readonly now: () => number = Date.now) {
    this.dir = usageDataDir(tomoHome);
    this.path = join(this.dir, "limits.ndjson");
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
    const previous = this.last.get(stream);
    if (previous && previous.key === key && now - previous.at < LIMITS_REPEAT_MS) return;
    this.last.set(stream, { key, at: now });
    const sample: LimitSample = { v: LIMITS_LOG_VERSION, ts: new Date(now).toISOString(), source, windows };
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.path, `${JSON.stringify(sample)}\n`, "utf8");
    } catch (err) {
      // Forget it, so the next sample is not deduplicated against a line that never landed.
      if (this.last.get(stream)?.at === now) this.last.delete(stream);
      await this.warn(err);
    }
  }

  private async warn(err: unknown): Promise<void> {
    log.warn({ err: err instanceof Error ? err.message : String(err), path: this.path }, "Could not record a usage-limit sample");
  }
}

const shared = new Map<string, LimitsLog>();
/** One log per tomo home, so `/usage` and the web card share the dedup state. */
export function limitsLogFor(tomoHome: string): LimitsLog {
  let existing = shared.get(tomoHome);
  if (!existing) shared.set(tomoHome, existing = new LimitsLog(tomoHome));
  return existing;
}
