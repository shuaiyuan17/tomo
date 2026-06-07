import { existsSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./logger.js";
import type { Agent } from "./agent.js";
import { runContinuityScript, type ContinuityScriptConfig } from "./continuity-script.js";

const CONTINUITY_INTERVAL_MS = 55 * 60 * 1000; // 55 minutes
const DEFAULT_TRIGGER_DIR = join(homedir(), ".tomo");

interface ContinuityRunnerOptions {
  triggerDir?: string;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;

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
  }

  start(): void {
    log.info("Continuity runner started (every 55m)");
    this.timer = setInterval(() => this.fire(), CONTINUITY_INTERVAL_MS);
    this.watchTrigger();
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

    const prompt = `System: It is ${timestamp}.${weatherLine} Read CONTINUITY.md. This is free time — reflect, research, or prepare something useful.${scriptLine}`;

    log.info({
      city: this.city,
      weather: weatherLine || "(none)",
      script: this.script?.path ?? "(none)",
    }, "Continuity heartbeat fired");

    try {
      await this.agent.handleContinuity(prompt);
      log.info("Continuity heartbeat completed");
    } catch (err) {
      log.error({ err }, "Continuity heartbeat failed");
    }
  }
}
