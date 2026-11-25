import { ownerT } from "./i18n/index.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { log } from "./logger.js";
import type { Agent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOMO_HOME = join(homedir(), ".tomo");
const CACHE_FILE = join(TOMO_HOME, "data", ".version-check.json");
const REGISTRY_URL = "https://registry.npmjs.org/tomo-ai/latest";
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // re-evaluate every 12h
const FETCH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // fetch npm at most once per week
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 22;

export function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

interface VersionCache {
  latest: string;
  checkedAt: number;
  notifiedVersion?: string;
}

function isDaytime(): boolean {
  const hour = new Date().getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

function readCache(): VersionCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  mkdirSync(join(TOMO_HOME, "data"), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * A complete semver 2.0.0 version (semver.org's own pattern): no leading
 * zeroes in numeric parts, no empty identifiers, build metadata optional
 * after any prerelease. No `v` prefix. Used both to accept the registry's
 * answer and to compare versions, so the two can never disagree.
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Longer than any real version; also bounds the work SEMVER_RE does. */
const MAX_VERSION_LENGTH = 256;

function isSemver(v: string): boolean {
  return v.length <= MAX_VERSION_LENGTH && SEMVER_RE.test(v);
}

/** A version's three core parts and its prerelease identifiers (empty for a
 *  release), or null when it is not a complete semver version. Build
 *  metadata carries no precedence and is dropped. */
function parseVersion(v: string): { core: string[]; pre: string[] } | null {
  const m = isSemver(v) ? SEMVER_RE.exec(v) : null;
  if (!m) return null;
  return { core: [m[1], m[2], m[3]], pre: m[4] ? m[4].split(".") : [] };
}

/** Compare two numeric identifiers without leading zeroes (as SEMVER_RE
 *  guarantees) exactly: by length, then digit by digit. `Number` would lose
 *  precision past 2^53. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Semver precedence of two prerelease identifier lists (both non-empty).
 *  Numeric identifiers compare numerically and rank below alphanumeric ones,
 *  which compare in ASCII order; a shorter list that is a prefix ranks lower. */
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const aNum = /^\d+$/.test(a[i]);
    const bNum = /^\d+$/.test(b[i]);
    if (aNum && bNum) {
      const diff = compareNumeric(a[i], b[i]);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Is `latest` a higher version than `current`, by semver precedence? A
 * release outranks its own prereleases (`1.0.0` > `1.0.0-rc.2`), so someone
 * running an RC is told about the final release. Anything that is not a
 * complete semver version is never newer, and is never older either.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const diff = compareNumeric(a.core[i], b.core[i]);
    if (diff !== 0) return diff > 0;
  }
  if (a.pre.length === 0) return b.pre.length > 0;
  if (b.pre.length === 0) return false;
  return comparePrerelease(a.pre, b.pre) > 0;
}

// The registry response is remote input: it was once returned with no shape
// check at all, then interpolated into a command line and compared by
// `isNewer`. Only a complete version (SEMVER_RE above) is acted on.

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const version = data.version;
    if (typeof version !== "string" || !isSemver(version)) {
      if (version !== undefined) {
        log.warn({ version: String(version).slice(0, 100) }, "Ignoring malformed version from npm registry");
      }
      return null;
    }
    return version;
  } catch {
    return null;
  }
}

export class VersionChecker {
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Initial delayed check. Held so stop() can cancel it — an un-cancelled
   *  one fires against a checker the daemon has already torn down, and holds
   *  the event loop open for the rest of its delay. */
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  start(): void {
    log.info("Version checker started (weekly)");
    // Initial check after 60s to let channels initialize
    this.initialTimer = setTimeout(() => this.runCheck(), 60_000);
    this.timer = setInterval(() => this.runCheck(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /** Timer entry point. `check()` is async and nothing awaits it here, so an
   *  unguarded rejection (writeCache hitting ENOSPC/EACCES, say) would surface
   *  as an unhandled rejection — which Node turns into a process exit, killing
   *  the whole daemon over a failed version check. */
  private runCheck(): void {
    this.check().catch((err) => log.warn({ err }, "Version check failed"));
  }

  private async check(): Promise<void> {
    if (!isDaytime()) {
      log.debug("Version check deferred (outside daytime hours)");
      return;
    }

    const current = getCurrentVersion();
    const cache = readCache();

    // If we fetched within the cooldown, only check for pending notification
    if (cache && Date.now() - cache.checkedAt < FETCH_COOLDOWN_MS) {
      if (isNewer(cache.latest, current) && cache.notifiedVersion !== cache.latest) {
        await this.notify(current, cache.latest);
        writeCache({ ...cache, notifiedVersion: cache.latest });
      }
      return;
    }

    const latest = await fetchLatestVersion();
    if (!latest) {
      log.debug("Version check: failed to fetch from registry");
      return;
    }

    log.info({ current, latest }, "Version check completed");

    const newCache: VersionCache = {
      latest,
      checkedAt: Date.now(),
      notifiedVersion: cache?.notifiedVersion,
    };

    if (isNewer(latest, current) && newCache.notifiedVersion !== latest) {
      await this.notify(current, latest);
      newCache.notifiedVersion = latest;
    }

    writeCache(newCache);
  }

  private async notify(current: string, latest: string): Promise<void> {
    const text = ownerT("notices")("update", { latest, current });
    log.info({ current, latest }, "New version available, notifying user");
    try {
      await this.agent.sendNotification(text);
    } catch (err) {
      log.warn({ err }, "Failed to send version notification");
    }
  }
}
