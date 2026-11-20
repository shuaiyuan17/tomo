import { requestFailure, subscriptionLabel, usageWindows, type UsageResult } from "../agent/usage.js";
import type { WebUsage } from "./protocol.js";

/** Served from cache this long; the card refreshes on its own every 30 minutes. */
export const USAGE_TTL_MS = 30 * 60_000;
/** A forced refresh (`?refresh=1`) closer than this to the last attempt is served from cache. */
export const USAGE_REFRESH_MIN_MS = 30_000;
/**
 * The browser gets an answer within this, even when the endpoint or Claude
 * Code's token refresh is slower: then it is a "timeout" state, and the read
 * still finishes in the background and updates the cache.
 */
export const USAGE_DEADLINE_MS = 20_000;
/** After a deadline miss the card asks again this soon (the read has usually finished by then). */
export const USAGE_TIMEOUT_RETRY_MS = 60_000;
/** A failed read (no login, network, endpoint error, …) is cached only this long. */
export const USAGE_FAILURE_TTL_MS = 60_000;

/**
 * Daemon-side cache in front of the claude.ai usage endpoint (the same reader
 * `/usage` uses). One request at a time; results, including failures, are
 * kept for USAGE_TTL_MS; a forced refresh is debounced by
 * USAGE_REFRESH_MIN_MS so the browser cannot hammer the endpoint. A failure
 * keeps the last good windows (marked stale) so the card still shows them.
 */
export class UsageCache {
  private value: WebUsage | undefined;
  /** When `value` stops being served from cache: 30 minutes after a good read, 60 s after a failed one. */
  private validUntil = -Infinity;
  private lastAttemptAt = -Infinity;
  private inFlight: Promise<WebUsage> | undefined;

  constructor(private readonly fetchUsage: () => Promise<UsageResult>, private readonly now: () => number = Date.now) {}

  async get(refresh = false): Promise<WebUsage> {
    const now = this.now();
    if (this.inFlight) return this.withDeadline(this.inFlight);
    const fresh = this.value && now < this.validUntil;
    const debounced = now - this.lastAttemptAt < USAGE_REFRESH_MIN_MS;
    if (this.value && (refresh ? debounced : fresh)) return this.decorate(this.value, now);
    this.lastAttemptAt = now;
    const load = this.load().finally(() => { this.inFlight = undefined; });
    this.inFlight = load;
    return this.withDeadline(load);
  }

  private withDeadline(load: Promise<WebUsage>): Promise<WebUsage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<WebUsage>((resolve) => {
      timer = setTimeout(() => {
        const now = this.now();
        const previous = this.value?.windows.length ? this.value : undefined;
        resolve(this.decorate({ state: "timeout", message: "Claude usage unavailable: usage request timed out.", windows: previous?.windows ?? [],
          plan: previous?.plan, fetchedAt: now, updatedAt: previous?.updatedAt ?? null, stale: !!previous,
          nextRefreshAt: 0, expiresAt: 0, serverNow: now }, now, now + USAGE_TIMEOUT_RETRY_MS));
      }, USAGE_DEADLINE_MS);
      timer.unref?.();
    });
    return Promise.race([load, late]).finally(() => clearTimeout(timer));
  }

  private async load(): Promise<WebUsage> {
    let result: UsageResult;
    try { result = await this.fetchUsage(); }
    catch { result = requestFailure("network"); }
    const now = this.now();
    if (result.ok) {
      const windows = usageWindows(result.data);
      this.value = { state: windows.length ? "ok" : "empty", windows, plan: subscriptionLabel(result.subscriptionType) || undefined,
        fetchedAt: now, updatedAt: now, nextRefreshAt: now + USAGE_REFRESH_MIN_MS, expiresAt: now + USAGE_TTL_MS, serverNow: now };
      this.validUntil = now + USAGE_TTL_MS;
    } else {
      const previous = this.value?.windows.length ? this.value : undefined;
      this.value = { state: result.reason, message: result.message, windows: previous?.windows ?? [], plan: previous?.plan,
        fetchedAt: now, updatedAt: previous?.updatedAt ?? null, stale: !!previous, nextRefreshAt: now + USAGE_REFRESH_MIN_MS,
        expiresAt: now + USAGE_FAILURE_TTL_MS, serverNow: now };
      this.validUntil = now + USAGE_FAILURE_TTL_MS;
    }
    return this.decorate(this.value, now);
  }

  private decorate(value: WebUsage, now: number, expiresAt = this.validUntil): WebUsage {
    return { ...value, nextRefreshAt: Math.max(now, this.lastAttemptAt + USAGE_REFRESH_MIN_MS), expiresAt, serverNow: now };
  }
}
