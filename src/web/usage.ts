import { subscriptionLabel, usageWindows, type UsageResult } from "../agent/usage.js";
import type { WebUsage } from "./protocol.js";

/** Served from cache this long; the card refreshes on its own every 30 minutes. */
export const USAGE_TTL_MS = 30 * 60_000;
/** A forced refresh (`?refresh=1`) closer than this to the last attempt is served from cache. */
export const USAGE_REFRESH_MIN_MS = 30_000;

/**
 * Daemon-side cache in front of the claude.ai usage endpoint (the same reader
 * `/usage` uses). One request at a time; results, including failures, are
 * kept for USAGE_TTL_MS; a forced refresh is debounced by
 * USAGE_REFRESH_MIN_MS so the browser cannot hammer the endpoint. A failure
 * keeps the last good windows (marked stale) so the card still shows them.
 */
export class UsageCache {
  private value: WebUsage | undefined;
  private lastAttemptAt = -Infinity;
  private inFlight: Promise<WebUsage> | undefined;

  constructor(private readonly fetchUsage: () => Promise<UsageResult>, private readonly now: () => number = Date.now) {}

  async get(refresh = false): Promise<WebUsage> {
    const now = this.now();
    if (this.inFlight) return this.inFlight;
    const fresh = this.value && now - this.lastAttemptAt < USAGE_TTL_MS;
    const debounced = now - this.lastAttemptAt < USAGE_REFRESH_MIN_MS;
    if (this.value && (refresh ? debounced : fresh)) return this.decorate(this.value, now);
    this.lastAttemptAt = now;
    this.inFlight = this.load().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async load(): Promise<WebUsage> {
    let result: UsageResult;
    try { result = await this.fetchUsage(); }
    catch { result = { ok: false, reason: "network", message: "Claude usage unavailable: network error." }; }
    const now = this.now();
    if (result.ok) {
      const windows = usageWindows(result.data);
      this.value = { state: windows.length ? "ok" : "empty", windows, plan: subscriptionLabel(result.subscriptionType) || undefined,
        fetchedAt: now, updatedAt: now, nextRefreshAt: now + USAGE_REFRESH_MIN_MS };
    } else {
      const previous = this.value?.windows.length ? this.value : undefined;
      this.value = { state: result.reason, message: result.message, windows: previous?.windows ?? [], plan: previous?.plan,
        fetchedAt: now, updatedAt: previous?.updatedAt ?? null, stale: !!previous, nextRefreshAt: now + USAGE_REFRESH_MIN_MS };
    }
    return this.decorate(this.value, now);
  }

  private decorate(value: WebUsage, now: number): WebUsage {
    return { ...value, nextRefreshAt: Math.max(now, this.lastAttemptAt + USAGE_REFRESH_MIN_MS) };
  }
}
