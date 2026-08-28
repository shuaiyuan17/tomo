# CLAUDE.md

## What is Tomo

Tomo is a personal AI assistant that lives in messaging apps (Telegram, iMessage). It runs as a long-running Node.js daemon on the user's machine, powered by the Claude Agent SDK. Users interact with it exclusively through chat — there is no web UI or terminal UI at runtime.

Published to npm as `tomo-ai`. Installed globally via `npm install -g tomo-ai`.

## Commands

```bash
npm run build                  # tsc — compile src/ → dist/
npm run dev                    # tsx watch, foreground with hot reload
npm run lint                   # eslint (src/ + tests/)
npm test                       # vitest — full suite
npx vitest run tests/<file>    # single test file (shared fixtures in tests/helpers/)
```

## Architecture Overview

```
src/
  cli.ts              # Entry point — commander CLI
  cli/                # Subcommands: start, config, backup, lcm, cron, sessions, etc.
  agent.ts            # Agent orchestrator — ingress, turn dispatch, notifications, context nudges
  agent/              # Turn execution internals:
    turn-runner.ts          # Runs a turn with retry + NO_REPLY silent-reply policy
    live-session-manager.ts # Owns LiveSession lifecycle — create/resume, reset-and-retry
    live-session.ts         # Wraps SDK query() streaming; steering merge/promotion
    delivery-pipeline.ts    # Streams + finalizes outbound messages to channels
    commands.ts             # Chat slash commands (/new, /model, /summon, /login, ...)
    scaffold-filter.ts      # Strips training-scaffold leaks from outbound text
    context-nudge.ts        # Pure decision logic for context-usage nudges
    sdk-options.ts          # Builds SDK query options (model, MCP servers, auto-compact policy)
    audience.ts             # DM-session audience tracking (private DM vs summoned group)
    inbound-batcher.ts      # Coalesces messages that pile up behind an in-flight turn
    proactive-send.ts       # send_message service (direct + delegate modes)
    #  plus: session-queue, pending-notes-queue, send-target, permissions, text-utils, claude-login
  router.ts           # IdentityRouter — session key resolution, allowlists, summons
  people.ts           # People registry — person records, alias/handle resolution, auto-binding
  config.ts           # Config from ~/.tomo/config.json + env vars (zod-validated)
  tomo-event.ts       # <tomo-event> envelope for harness-composed messages
  auth.ts             # Anthropic auth resolution (env key > config; subscription or API key)
  channels/           # Channel implementations (Telegram, iMessage via the imsg CLI)
  sessions/           # Persistence (store.ts), key helpers (keys.ts), summon-store.ts
  mcp/                # tomo-internal in-process MCP server (internal-server.ts) + tool factories
                      #   (cron-, people-, recall-, pet-tools); external-config.ts, oauth.ts
  cron/               # Scheduler (30s poll → agent.handleCronMessage) + store (data/cron/jobs.json)
  lcm/                # Context mgmt — compact, stats, prune-tools, blocks (rollups), runner
  continuity.ts       # ContinuityRunner — periodic heartbeats for autonomous behavior
  watch/              # `tomo watch` mission-control TUI: bus.ts (in-process event bus emitters
                      #   publish to), server.ts (NDJSON over ~/.tomo/watch.sock), snapshot.ts,
                      #   client.ts, tui/ (Ink app — feed, vitals sidebar, chat line, log tail)
  metrics/            # Prometheus exporter (exporter.ts, /metrics on 127.0.0.1:9464) + NDJSON
                      #   activity log (activity-log.ts) — both WatchBus subscribers, gated by
                      #   config.metrics; Grafana stack in contrib/observability/
  costs.ts, models.ts, litellm.ts        # /cost reports; model aliases; LiteLLM gateway modes
  jsonl.ts, fs-utils.ts, runtime-paths.ts # JSONL readers; atomic writes; SDK session file paths
  version.ts          # VersionChecker — weekly npm registry check, daytime-only notification
  workspace/          # System prompt builder (SOUL.md + AGENT.md + IDENTITY.md + memory)
  logger.ts           # Pino structured logging
```

Runtime data lives at `~/.tomo/` (config, sessions, cron jobs, logs, workspace, memory).

## Key Design Patterns

### Session Keys

Session keys determine conversation isolation:
- **With identity**: `dm:<identityName>` — unified across all channels (Telegram + iMessage share one session)
- **Without identity**: `<channel>:<chatId>` — e.g., `telegram:123456789`
- **Group chats**: always `<channel>:<chatId>` — never unified

The `IdentityRouter` resolves (channel, chatId, isGroup) → sessionKey + replyTarget.

### DM vs Group Detection

Use the helpers in `src/sessions/keys.ts` — don't re-parse keys by hand:
- `isDmSessionKey(key)` — true for `dm:` keys
- `parseRawSessionKey(key)` — `<channel>:<chatId>` → `{ channelName, chatId }` (undefined for `dm:` keys)
- `isGroupSessionKey(key)` — Telegram chatId starts with `-`; iMessage GUID contains `;+;`

### Live Sessions (SDK Integration)

`LiveSession` wraps the Claude Agent SDK `query()` call with an async generator for streaming multi-turn conversations. Key flow:
1. `getOrCreateLiveSession(key)` — reuses existing session or creates new one (with optional SDK session resume)
2. `session.send(text)` — sends a user message, returns the full assistant response
3. `runWithRetry(key, prompt)` — send with auto-retry on session errors (resets and retries once)

SDK session IDs are persisted in the session registry so conversations survive daemon restarts.

With config `steering` (default on), user messages that arrive mid-turn bypass the per-session queue via `session.steer(text)` — they either merge into the in-flight turn or are promoted to their own follow-up turn. Details (STEER_MERGED sentinel, replay detection, idle-wait) live in `src/agent/turn-runner.ts` and `src/agent/live-session.ts`; set `steering: false` or `TOMO_STEERING=false` to keep mid-turn messages queued.

### Message Flow

1. Channel receives message → `agent.enqueueMessage()` (serialized per session key)
2. `handleMessage()` — allowlist check, identity resolution, timestamp injection
3. `runWithRetry()` → `LiveSession.send()` → SDK query → streamed response
4. Response sent back through channel (with streaming updates via `createStreamingMessage`)

### Harness Message Envelope

All harness-composed messages (cron, heartbeats, nudges, summons, delegate requests) are wrapped in a `<tomo-event type=... name=... ts=...>` envelope by `formatTomoEvent()` (`src/tomo-event.ts`) — the single composer; never hand-roll `System:` strings. Bodies are injection-escaped so user-controlled text can't close the envelope early. Consumers must tolerate BOTH the envelope and the legacy `System:` / `[System: ...]` formats — old transcripts are never migrated. Outbound, `src/agent/scaffold-filter.ts` strips training-scaffold leaks before text reaches a channel.

### Sending Notifications (No Agent Query)

`agent.sendNotification(text)` sends a direct channel message without invoking Claude:
1. Tries `dm:` session via IdentityRouter
2. Falls back to first non-group session key from the registry
3. Uses `privateReplyTargetFromSessionKey()` (`src/sessions/keys.ts`) which excludes groups

Use this for system-level notifications (version updates, errors) that don't need AI processing.

### People Registry (Group Sender Recognition)

Person records live at `~/.tomo/workspace/memory/people/*.md` (DM-only records under `memory/private/people/`) — frontmatter holds `name`, `aliases`, per-channel handles; freeform notes below. Resolution is harness-side and deterministic (`src/people.ts`): channels attach a stable `senderId` to every message, group transcript lines are annotated inline (`kw 🚀 (Kevin Wang): ...`), and handles auto-bind the first time a sender's display name unambiguously matches an unbound public record. The agent maintains records via `list_people` / `upsert_person` MCP tools; a roster (names + aliases) is injected into every system prompt. Private records never enter group flows — excluded from group prompts, group-session tools, and file reads (private-memory guard hook), even when a summon routes group messages into a `dm:` session.

### System Prompt

Built by `workspace/index.ts` from layered markdown files:
- `SOUL.md` — personality and values
- `AGENT.md` — operating rules
- `IDENTITY.md` — name and quirks
- Memory system — injected from `~/.tomo/workspace/memory/`
- Harness instructions — NO_REPLY, MEDIA: tags, formatting rules

Changes to workspace files take effect on next message (no restart needed) — the prompt is rebuilt on each new LiveSession.

### Daemon Lifecycle

`tomo start` defaults to background (spawns detached child with `--foreground`). On macOS, `tomo config` can enable launchd autostart (LaunchAgent plist at `~/Library/LaunchAgents/ai.tomo.plist`).

`startForeground()` in `cli/start.ts` is the real entry point — it:
1. Creates Agent, adds channels
2. Starts CronScheduler, ContinuityRunner, VersionChecker
3. Writes PID file
4. Handles SIGINT/SIGTERM for clean shutdown

### Cron System

Users ask Tomo to schedule things via chat. The agent CRUDs jobs with the `schedule_create` / `schedule_list` / `schedule_remove` MCP tools (`src/mcp/cron-tools.ts`), backed by `~/.tomo/data/cron/jobs.json` (the `tomo cron` CLI is a parallel surface on the same store). The `CronScheduler` polls every 30s and fires due jobs via `agent.handleCronMessage()`, which delivers the response through the appropriate channel.

### LCM (Lifecycle Management)

Custom context management that operates on the SDK's JSONL session files directly (`src/lcm/`):
- `compact.ts` / `stats.ts` / `prune-tools.ts` — range summarization, usage breakdown, tool-result pruning
- `blocks.ts` + `runner.ts` — hierarchical rollups (daily → weekly → monthly → yearly summary blocks); the runner nudges the agent when a completed period is due for promotion

The harness emits context nudges at `lcm.nudgeAtPct` usage (default 70%, `src/config.ts`), escalating prune → daily rollup → full compact at 80% (decision logic in `src/agent/context-nudge.ts`).

## Code Conventions

- ESM throughout (`"type": "module"` in package.json)
- TypeScript strict mode
- Imports use `.js` extensions (Node16 module resolution)
- Logging via `log` from `./logger.ts` (pino) — use `log.info`, `log.warn`, `log.error`, `log.debug`
- No default exports — always named exports
- Config values are zod-validated: invalid entries collect into `configIssues` and `assertConfigValid()` refuses daemon startup (repair commands like `tomo config` still run)
