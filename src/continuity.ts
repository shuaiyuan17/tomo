import { existsSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";
import type { Agent } from "./agent.js";
import { runContinuityScript, type ContinuityScriptConfig } from "./continuity-script.js";
import { formatTomoEvent } from "./tomo-event.js";
import { watchBus } from "./watch/bus.js";
import { CONTINUITY_DELIVERY_NOTE, DEFAULT_CONTINUITY_INTERVAL_MS } from "./continuity-defaults.js";

const DEFAULT_TRIGGER_DIR = join(homedir(), ".tomo");

interface ContinuityRunnerOptions {
  triggerDir?: string;
  intervalMs?: number;
}

function normalizeIntervalMs(intervalMs: number | undefined): number {
  if (intervalMs === undefined) return DEFAULT_CONTINUITY_INTERVAL_MS;
  return Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : DEFAULT_CONTINUITY_INTERVAL_MS;
}

function formatIntervalMs(intervalMs: number): string {
  const minutes = intervalMs / 60_000;
  if (Number.isInteger(minutes)) return `${minutes}m`;
  const seconds = intervalMs / 1_000;
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${intervalMs}ms`;
}

async function fetchWeather(city: string): Promise<string | null> {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%c+%t+%h+%w`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

export class ContinuityRunner {
  private agent: Agent;
  private city: string | null;
  private script: ContinuityScriptConfig | null;
  private triggerDir: string;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  /** Last scheduled-tick time; interval fires are lastTickAt + intervalMs. */
  private lastTickAt: number | null = null;

  constructor(
    agent: Agent,
    city?: string | null,
    script?: ContinuityScriptConfig | null,
    options: ContinuityRunnerOptions = {},
  ) {
    this.agent = agent;
    this.city = city ?? null;
    this.script = script ?? null;
    this.triggerDir = options.triggerDir ?? DEFAULT_TRIGGER_DIR;
    this.intervalMs = normalizeIntervalMs(options.intervalMs);
  }

  start(): void {
    log.info({ intervalMs: this.intervalMs }, `Continuity runner started (every ${formatIntervalMs(this.intervalMs)})`);
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      this.lastTickAt = Date.now();
      this.fire();
    }, this.intervalMs);
    this.watchTrigger();
  }

  /** Approximate time of the next scheduled heartbeat (null when stopped). */
  nextFireAt(): number | null {
    if (!this.timer || this.lastTickAt === null) return null;
    return this.lastTickAt + this.intervalMs;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    log.info("Continuity runner stopped");
  }

  /** Watch for manual trigger file */
  private watchTrigger(): void {
    const triggerFile = join(this.triggerDir, "continuity.trigger");
    try {
      this.watcher = watch(this.triggerDir, (_event, filename) => {
        if (filename === "continuity.trigger" && existsSync(triggerFile)) {
          try { unlinkSync(triggerFile); } catch { /* ignore */ }
          log.info("Continuity manually triggered");
          this.fire();
        }
      });
    } catch {
      // Watch not available — manual trigger won't work
    }
  }

  private async fire(): Promise<void> {
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });

    let weatherLine = "";
    if (this.city) {
      const weather = await fetchWeather(this.city);
      if (weather) {
        weatherLine = ` Weather outside: ${weather}.`;
      }
    }

    let scriptLine = "";
    if (this.script) {
      scriptLine = `\n\n${await runContinuityScript(this.script)}`;
    }

    const prompt = formatTomoEvent(
      "heartbeat",
      `It is ${timestamp}.${weatherLine} Read CONTINUITY.md. This is free time — reflect, research, or prepare something useful. ${CONTINUITY_DELIVERY_NOTE}${scriptLine}`,
      { ts: now },
    );

    log.info({
      city: this.city,
      weather: weatherLine || "(none)",
      script: this.script?.path ?? "(none)",
    }, "Continuity heartbeat fired");
    watchBus.publish({ type: "heartbeat" });

    try {
      await this.agent.handleContinuity(prompt);
      log.info("Continuity heartbeat completed");
    } catch (err) {
      log.error({ err }, "Continuity heartbeat failed");
    }
  }
}
