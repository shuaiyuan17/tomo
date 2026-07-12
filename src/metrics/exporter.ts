import { createServer, type Server } from "node:http";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { log } from "../logger.js";
import { watchBus, type WatchBus } from "../watch/bus.js";
import type { WatchEvent } from "../watch/protocol.js";
import type { CronJob } from "../cron/types.js";

export const DEFAULT_METRICS_PORT = 9464;

/**
 * Binding beyond loopback would expose turn/cost/session telemetry to the
 * network with no auth; anything remote should scrape through a collector
 * running on this machine.
 */
const METRICS_HOST = "127.0.0.1";

export interface MetricsExporterOptions {
  /** Stamped onto the tomo_build_info gauge. */
  version?: string;
  model?: string;
  bus?: WatchBus;
  /** Own registry per instance so tests never share prom-client global state. */
  registry?: Registry;
  /** Point-in-time state read at scrape time (same sources as the watch
   *  snapshot) — for things that aren't events, like upcoming cron runs. */
  collectors?: {
    cronJobs?: () => CronJob[];
    nextHeartbeatAt?: () => number | null;
  };
}

/**
 * Prometheus exporter for daemon observability. One more WatchBus subscriber
 * (next to the watch socket server): emit points stay the single source of
 * truth and this module never imports agent internals. Serves the standard
 * text exposition on http://127.0.0.1:<port>/metrics.
 */
export class MetricsExporter {
  readonly registry: Registry;
  private readonly bus: WatchBus;
  private server: Server | null = null;
  private unsubscribe: (() => void) | null = null;
  private turnsInFlight = 0;

  private readonly buildInfo: Gauge;
  private readonly messages: Counter;
  private readonly turns: Counter;
  private readonly turnDuration: Histogram;
  private readonly turnsActive: Gauge;
  private readonly costUsd: Counter;
  private readonly contextUsedTokens: Gauge;
  private readonly contextMaxTokens: Gauge;
  private readonly toolCalls: Counter;
  private readonly toolDuration: Histogram;
  private readonly cronRuns: Counter;
  private readonly cronNextRun: Gauge;
  private readonly heartbeats: Counter;
  private readonly heartbeatNext: Gauge;
  private readonly heartbeatLast: Gauge;
  private readonly compactions: Counter;
  private readonly issues: Counter;

  constructor(private readonly options: MetricsExporterOptions = {}) {
    this.bus = options.bus ?? watchBus;
    this.registry = options.registry ?? new Registry();
    const registers = [this.registry];

    this.buildInfo = new Gauge({
      name: "tomo_build_info",
      help: "Constant 1, labeled with daemon version and configured model.",
      labelNames: ["version", "model"],
      registers,
    });
    this.messages = new Counter({
      name: "tomo_messages_total",
      help: "Transcript messages by role and channel.",
      labelNames: ["role", "channel"],
      registers,
    });
    this.turns = new Counter({
      name: "tomo_turns_total",
      help: "Completed agent turns by source and outcome.",
      labelNames: ["source", "ok"],
      registers,
    });
    this.turnDuration = new Histogram({
      name: "tomo_turn_duration_seconds",
      help: "Agent turn duration by source.",
      labelNames: ["source"],
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
      registers,
    });
    this.turnsActive = new Gauge({
      name: "tomo_turns_active",
      help: "Turns currently in flight.",
      registers,
    });
    this.costUsd = new Counter({
      name: "tomo_cost_usd_total",
      help: "Cumulative API cost in USD (from SDK per-query results).",
      registers,
    });
    this.contextUsedTokens = new Gauge({
      name: "tomo_context_used_tokens",
      help: "Context tokens used, per session (from the last turn).",
      labelNames: ["session"],
      registers,
    });
    this.contextMaxTokens = new Gauge({
      name: "tomo_context_max_tokens",
      help: "Context window size, per session.",
      labelNames: ["session"],
      registers,
    });
    this.toolCalls = new Counter({
      name: "tomo_tool_calls_total",
      help: "Tool invocations by tool name and outcome.",
      labelNames: ["tool", "ok"],
      registers,
    });
    this.toolDuration = new Histogram({
      name: "tomo_tool_duration_seconds",
      help: "Tool call duration by tool name.",
      labelNames: ["tool"],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60],
      registers,
    });
    // Cron label is `cron_job`, not `job`: Prometheus reserves `job` for the
    // scrape target and would rename a colliding label to `exported_job`.
    this.cronRuns = new Counter({
      name: "tomo_cron_runs_total",
      help: "Cron job completions by job name and outcome.",
      labelNames: ["cron_job", "ok"],
      registers,
    });
    const collectors = options.collectors;
    this.cronNextRun = new Gauge({
      name: "tomo_cron_next_run_timestamp_seconds",
      help: "Next scheduled run per enabled cron job (unix seconds).",
      labelNames: ["cron_job"],
      registers,
      collect() {
        if (!collectors?.cronJobs) return;
        this.reset(); // drop labels for removed/disabled jobs
        for (const job of collectors.cronJobs()) {
          if (!job.enabled || job.nextRunAt === null) continue;
          this.set({ cron_job: job.name }, job.nextRunAt / 1000);
        }
      },
    });
    this.heartbeatNext = new Gauge({
      name: "tomo_heartbeat_next_timestamp_seconds",
      help: "Next scheduled continuity heartbeat (unix seconds; 0 = continuity off).",
      registers,
      collect() {
        if (!collectors?.nextHeartbeatAt) return;
        // Unlabeled gauges always export a sample; 0 means continuity is off.
        this.set((collectors.nextHeartbeatAt() ?? 0) / 1000);
      },
    });
    this.heartbeatLast = new Gauge({
      name: "tomo_heartbeat_last_timestamp_seconds",
      help: "When the last continuity heartbeat fired (unix seconds; 0 = never).",
      registers,
    });
    this.heartbeats = new Counter({
      name: "tomo_heartbeats_total",
      help: "Continuity heartbeats fired.",
      registers,
    });
    this.compactions = new Counter({
      name: "tomo_compactions_total",
      help: "Context compactions performed.",
      registers,
    });
    this.issues = new Counter({
      name: "tomo_issues_total",
      help: "Warn/error issues published on the watch bus.",
      labelNames: ["level"],
      registers,
    });
  }

  /** Resolves once the HTTP listener is up (or errored — never rejects; a
   *  taken port degrades to a warning, the bus subscription still counts). */
  start(port = DEFAULT_METRICS_PORT): Promise<void> {
    collectDefaultMetrics({ register: this.registry });
    this.buildInfo.set(
      { version: this.options.version ?? "unknown", model: this.options.model ?? "unknown" },
      1,
    );

    this.unsubscribe = this.bus.subscribe((event) => this.record(event));

    const server = createServer((req, res) => {
      if (req.method !== "GET" || new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found. Try /metrics\n");
        return;
      }
      this.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { "content-type": this.registry.contentType }).end(body);
        })
        .catch((err: unknown) => {
          log.warn({ err }, "Metrics collection failed");
          res.writeHead(500, { "content-type": "text/plain" }).end("metrics collection failed\n");
        });
    });
    this.server = server;
    return new Promise((resolve) => {
      server.on("error", (err) => {
        log.warn({ err, port }, "Metrics server error");
        resolve();
      });
      server.listen(port, METRICS_HOST, () => {
        log.info({ port: this.port() }, "Metrics exporter listening");
        resolve();
      });
    });
  }

  /** Actual bound port (differs from the requested one when it was 0). */
  port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.server?.close();
    this.server = null;
    this.registry.clear();
  }

  private record(event: WatchEvent): void {
    switch (event.type) {
      case "transcript":
        this.messages.inc({ role: event.role, channel: event.channel });
        break;
      case "turn.start":
        this.turnsActive.set(++this.turnsInFlight);
        break;
      case "turn.end":
        // A crashed turn can skip its end event; never let the gauge go negative.
        this.turnsInFlight = Math.max(0, this.turnsInFlight - 1);
        this.turnsActive.set(this.turnsInFlight);
        this.turns.inc({ source: event.source, ok: String(event.ok) });
        this.turnDuration.observe({ source: event.source }, event.durationMs / 1000);
        break;
      case "turn.stats":
        if (event.costUsd > 0) this.costUsd.inc(event.costUsd);
        this.contextUsedTokens.set({ session: event.sessionKey }, event.contextUsed);
        this.contextMaxTokens.set({ session: event.sessionKey }, event.contextMax);
        break;
      case "tool.end":
        this.toolCalls.inc({ tool: event.tool, ok: String(event.ok) });
        if (event.durationMs !== undefined) {
          this.toolDuration.observe({ tool: event.tool }, event.durationMs / 1000);
        }
        break;
      case "cron.done":
        this.cronRuns.inc({ cron_job: event.name, ok: String(event.ok) });
        break;
      case "heartbeat":
        this.heartbeats.inc();
        this.heartbeatLast.set(event.ts / 1000);
        break;
      case "compact":
        this.compactions.inc();
        break;
      case "issue":
        this.issues.inc({ level: event.level });
        break;
      default:
        break;
    }
  }
}
