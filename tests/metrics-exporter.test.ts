import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchBus } from "../src/watch/bus.js";
import { MetricsExporter } from "../src/metrics/exporter.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function metricValue(
  exporter: MetricsExporter,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const metrics = await exporter.registry.getMetricsAsJSON();
  const metric = metrics.find((m) => m.name === name);
  const values = (metric?.values ?? []) as Array<{ value: number; labels: Record<string, string | number> }>;
  const match = values.find((v) =>
    Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val),
  );
  return match?.value;
}

describe("MetricsExporter", () => {
  let bus: WatchBus;
  let exporter: MetricsExporter;

  beforeEach(async () => {
    bus = new WatchBus();
    exporter = new MetricsExporter({ bus, version: "0.0.0-test", model: "claude-test" });
    await exporter.start(0); // ephemeral port
  });

  afterEach(() => {
    exporter.stop();
  });

  it("counts turns by source and outcome, and observes duration", async () => {
    bus.publish({ type: "turn.end", sessionKey: "dm:me", source: "user", ok: true, durationMs: 4200 });
    bus.publish({ type: "turn.end", sessionKey: "dm:me", source: "user", ok: true, durationMs: 1000 });
    bus.publish({ type: "turn.end", sessionKey: "dm:me", source: "cron", ok: false, durationMs: 500 });

    expect(await metricValue(exporter, "tomo_turns_total", { source: "user", ok: "true" })).toBe(2);
    expect(await metricValue(exporter, "tomo_turns_total", { source: "cron", ok: "false" })).toBe(1);
    // Histogram sum: 4.2s + 1s observed for source=user.
    const metrics = await exporter.registry.getMetricsAsJSON();
    const hist = metrics.find((m) => m.name === "tomo_turn_duration_seconds");
    const sum = (hist?.values as Array<{ metricName?: string; value: number; labels: Record<string, string> }>)
      .find((v) => v.metricName === "tomo_turn_duration_seconds_sum" && v.labels.source === "user");
    expect(sum?.value).toBeCloseTo(5.2);
  });

  it("tracks in-flight turns without going negative", async () => {
    bus.publish({ type: "turn.start", sessionKey: "dm:me", source: "user" });
    bus.publish({ type: "turn.start", sessionKey: "telegram:1", source: "cron" });
    expect(await metricValue(exporter, "tomo_turns_active")).toBe(2);

    bus.publish({ type: "turn.end", sessionKey: "dm:me", source: "user", ok: true, durationMs: 10 });
    bus.publish({ type: "turn.end", sessionKey: "telegram:1", source: "cron", ok: true, durationMs: 10 });
    // A stray extra end (crashed turn missed its start) must clamp at zero.
    bus.publish({ type: "turn.end", sessionKey: "dm:me", source: "user", ok: false, durationMs: 10 });
    expect(await metricValue(exporter, "tomo_turns_active")).toBe(0);
  });

  it("accumulates cost and sets per-session context gauges", async () => {
    bus.publish({ type: "turn.stats", sessionKey: "dm:me", costUsd: 0.05, contextUsed: 40_000, contextMax: 200_000 });
    bus.publish({ type: "turn.stats", sessionKey: "dm:me", costUsd: 0.03, contextUsed: 55_000, contextMax: 200_000 });

    expect(await metricValue(exporter, "tomo_cost_usd_total")).toBeCloseTo(0.08);
    expect(await metricValue(exporter, "tomo_context_used_tokens", { session: "dm:me" })).toBe(55_000);
    expect(await metricValue(exporter, "tomo_context_max_tokens", { session: "dm:me" })).toBe(200_000);
  });

  it("counts messages, tools, cron runs, compactions, and issues", async () => {
    bus.publish({ type: "transcript", sessionKey: "dm:me", role: "user", channel: "telegram", text: "hi" });
    bus.publish({ type: "transcript", sessionKey: "dm:me", role: "assistant", channel: "telegram", text: "hello" });
    bus.publish({ type: "tool.end", tool: "schedule_create", ok: true, durationMs: 120 });
    bus.publish({ type: "cron.done", jobId: "j1", name: "morning brief", ok: true });
    bus.publish({ type: "compact", sessionKey: "dm:me" });
    bus.publish({ type: "issue", level: "error", msg: "boom" });
    bus.publish({ type: "heartbeat" });

    expect(await metricValue(exporter, "tomo_messages_total", { role: "user", channel: "telegram" })).toBe(1);
    expect(await metricValue(exporter, "tomo_messages_total", { role: "assistant", channel: "telegram" })).toBe(1);
    expect(await metricValue(exporter, "tomo_tool_calls_total", { tool: "schedule_create", ok: "true" })).toBe(1);
    expect(await metricValue(exporter, "tomo_cron_runs_total", { cron_job: "morning brief", ok: "true" })).toBe(1);
    expect(await metricValue(exporter, "tomo_compactions_total")).toBe(1);
    expect(await metricValue(exporter, "tomo_issues_total", { level: "error" })).toBe(1);
    expect(await metricValue(exporter, "tomo_heartbeats_total")).toBe(1);
  });

  /**
   * The outlet guard (src/agent/inbound-markers.ts) delivers a fabricated
   * inbound marker rather than cutting it, so the ONLY way to notice the rate
   * at which the model does this is a counter. `tomo status` runs in a
   * different process from the daemon and could never read an in-memory one;
   * the exporter is where daemon counters live.
   */
  it("counts fabricated inbound markers in outgoing text, by session and shape", async () => {
    bus.publish({ type: "fabricated-marker", sessionKey: "dm:me", shape: "stamp", marker: "[imessage · Sat 08/29 08:25 PDT] hi" });
    bus.publish({ type: "fabricated-marker", sessionKey: "dm:me", shape: "stamp", marker: "[telegram · Sat 08/29 09:00 PDT] yo" });
    bus.publish({ type: "fabricated-marker", sessionKey: "telegram:-100", shape: "tomo-event", marker: "<tomo-event type=\"cron\">" });
    // A block from an unowned SDK turn has no session key; it must still count.
    bus.publish({ type: "fabricated-marker", shape: "legacy-system", marker: "System: heartbeat" });

    expect(await metricValue(exporter, "tomo_fabricated_markers_total", { session: "dm:me", shape: "stamp" })).toBe(2);
    expect(await metricValue(exporter, "tomo_fabricated_markers_total", { session: "telegram:-100", shape: "tomo-event" })).toBe(1);
    expect(await metricValue(exporter, "tomo_fabricated_markers_total", { session: "unknown", shape: "legacy-system" })).toBe(1);
  });

  it("exports upcoming cron runs and heartbeat schedule from collectors", async () => {
    exporter.stop();
    let nextHeartbeat: number | null = 1_800_000_000_000;
    const jobs = [
      { id: "a", name: "morning brief", enabled: true, nextRunAt: 1_800_000_100_000 },
      { id: "b", name: "disabled job", enabled: false, nextRunAt: 1_800_000_200_000 },
      { id: "c", name: "never scheduled", enabled: true, nextRunAt: null },
    ];
    exporter = new MetricsExporter({
      bus,
      collectors: {
        cronJobs: () => jobs as never,
        nextHeartbeatAt: () => nextHeartbeat,
      },
    });
    await exporter.start(0);

    expect(await metricValue(exporter, "tomo_cron_next_run_timestamp_seconds", { cron_job: "morning brief" }))
      .toBe(1_800_000_100);
    // Disabled and unscheduled jobs export no sample at all.
    const metrics = await exporter.registry.getMetricsAsJSON();
    const cronGauge = metrics.find((m) => m.name === "tomo_cron_next_run_timestamp_seconds");
    expect(cronGauge?.values).toHaveLength(1);

    expect(await metricValue(exporter, "tomo_heartbeat_next_timestamp_seconds")).toBe(1_800_000_000);
    // Continuity turned off mid-flight: the gauge reports the 0 sentinel.
    nextHeartbeat = null;
    expect(await metricValue(exporter, "tomo_heartbeat_next_timestamp_seconds")).toBe(0);

    bus.publish({ type: "heartbeat", ts: 1_800_000_050_000 });
    expect(await metricValue(exporter, "tomo_heartbeat_last_timestamp_seconds")).toBe(1_800_000_050);
  });

  it("serves the Prometheus text format over HTTP on /metrics only", async () => {
    bus.publish({ type: "heartbeat" });
    const port = exporter.port();
    expect(port).not.toBeNull();

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("tomo_heartbeats_total 1");
    expect(body).toContain('tomo_build_info{version="0.0.0-test",model="claude-test"} 1');
    expect(body).toContain("process_cpu_user_seconds_total"); // default process metrics

    const miss = await fetch(`http://127.0.0.1:${port}/other`);
    expect(miss.status).toBe(404);
  });

  it("stops cleanly: unsubscribes from the bus and frees the port", async () => {
    const port = exporter.port();
    exporter.stop();
    bus.publish({ type: "heartbeat" }); // must not throw against a cleared registry
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
  });
});
