# Tomo observability stack

A self-contained Grafana + Prometheus + Loki + Alloy stack for watching Tomo
from a dashboard. Data never leaves the machine: Prometheus, Loki, and Alloy
bind to `127.0.0.1` only. Grafana is reachable from the local network (login
required) so you can open the dashboard from another computer.

```
Tomo daemon ──/metrics (127.0.0.1:9464)──▶ Prometheus ──┐
     │                                                  ├──▶ Grafana (127.0.0.1:3000)
     └──~/.tomo/logs/activity.ndjson──▶ Alloy ──▶ Loki ─┘
```

## Setup

1. Enable metrics in `~/.tomo/config.json`:

   ```json
   {
     "metrics": { "enabled": true }
   }
   ```

   Then restart the daemon (`tomo restart`) and verify:

   ```bash
   curl -s localhost:9464/metrics | grep tomo_
   ```

2. Copy the stack somewhere you own, then start it (requires Docker Desktop).
   Copying matters: run it in place and an `npm upgrade` will overwrite any
   compose/dashboard customizations.

   ```bash
   # from a git clone:
   cp -r contrib/observability ~/tomo-observability
   # or from a global npm install:
   cp -r "$(npm root -g)/tomo-ai/contrib/observability" ~/tomo-observability

   cd ~/tomo-observability
   docker compose up -d
   ```

3. Open <http://localhost:3000> — or from another computer on your network,
   `http://<hostname>.local:3000` (e.g. `http://mac-mini.local:3000`). Sign in
   with `admin` / `admin`; Grafana forces a password change on first login.
   The **Tomo** dashboard is pre-provisioned.

   To restrict Grafana to this machine only, change its port mapping back to
   `"127.0.0.1:3000:3000"` in `docker-compose.yml`. For access from *outside*
   your home network, don't port-forward — use Tailscale or similar.

## Config reference

`~/.tomo/config.json` → `metrics` (env overrides in parens):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` (`TOMO_METRICS`) | `false` | Serve `/metrics` and write the activity log |
| `port` (`TOMO_METRICS_PORT`) | `9464` | Prometheus exporter port, loopback-only |
| `activityLog` | `true` | Write `~/.tomo/logs/activity.ndjson` for Loki |
| `includeMessageText` | `true` | Include transcript text in the activity log. Disable if you ever ship the log off this machine. |

## What's collected

**Prometheus** (`tomo_*`, plus standard `process_*`/`nodejs_*`): turns by
source/outcome, turn duration histogram, cumulative cost (USD), per-session
context usage, tool calls, cron runs + upcoming cron schedule, compactions,
heartbeats (count, last, next), warn/error issues.

**Loki** (`{job="tomo-activity"}`): every watch-bus event as structured JSON —
the same feed `tomo watch` renders. Labels: `type`, `session`, `level`.
Example queries:

```logql
{job="tomo-activity", type="tool.start"}                # every tool call
{job="tomo-activity", type="transcript", session="dm:merlin"}
{job="tomo-activity"} | json | costUsd > 0.10           # expensive turns
```

## Notes

- Prometheus keeps 90 days of metrics; Loki uses its default retention.
  Volumes (`prometheus-data`, `loki-data`, `grafana-data`) survive
  `docker compose down`; add `-v` to wipe them.
- Counters reset when the daemon restarts — dashboard queries use
  `increase()`/`rate()`, which handle resets.
- If `TOMO_HOME` is not `~/.tomo`, fix the Alloy volume mount in
  `docker-compose.yml`.
- History starts when you enable the stack; nothing is backfilled.
