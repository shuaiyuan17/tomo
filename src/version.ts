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

function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export class VersionChecker {
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  start(): void {
    log.info("Version checker started (weekly)");
    // Initial check after 60s to let channels initialize
    setTimeout(() => this.check(), 60_000);
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    const text = `Tomo v${latest} is available (current: v${current}).\nRun: npm update -g tomo-ai && tomo restart`;
    log.info({ current, latest }, "New version available, notifying user");
    try {
      await this.agent.sendNotification(text);
    } catch (err) {
      log.warn({ err }, "Failed to send version notification");
    }
  }
}
