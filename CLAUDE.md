# CLAUDE.md

## What is Tomo

Tomo is a personal AI assistant that lives in messaging apps (Telegram, iMessage). It runs as a long-running Node.js daemon on the user's machine, powered by the Claude Agent SDK. Users interact with it exclusively through chat — there is no web UI or terminal UI at runtime.

Published to npm as `tomo-ai`. Installed globally via `npm install -g tomo-ai`.

## Commands

```bash
npm run build    # tsc — compile src/ → dist/
npm run dev      # tsx watch, foreground with hot reload
npm run lint     # eslint
npm test         # vitest
```

## Architecture Overview

```
src/
  cli.ts              # Entry point — commander CLI
  cli/                # Subcommands: start, stop, config, init, etc.
  agent.ts            # Core Agent class — message routing, live sessions, channel management
  router.ts           # IdentityRouter — session key resolution, DM vs group, allowlists
  config.ts           # Config loading from ~/.tomo/config.json + env vars
  channels/           # Channel implementations (Telegram, iMessage/BlueBubbles)
    types.ts          # Channel interface: onMessage, send, startTyping, etc.
    telegram.ts
    imessage.ts
  sessions/           # Session persistence
    store.ts          # SessionStore — transcript files, SDK session registry, stats
    types.ts          # SessionMessage, SessionEntry, ReplyTarget, etc.
  cron/               # Scheduled tasks (user-created reminders, recurring jobs)
    scheduler.ts      # Polls every 30s, fires due jobs via agent.handleCronMessage()
    store.ts          # CRUD for cron jobs (persisted in ~/.tomo/data/cron/jobs.json)
  lcm/                # Lifecycle management — context compaction, stats, tool pruning
  continuity.ts       # ContinuityRunner — periodic heartbeats for autonomous behavior
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

- Telegram groups: chatId is negative (starts with `-`)
- iMessage groups: chatId GUID contains `;+;`
- `parseChannelKey()` in Agent uses this to filter — reuse it when you need DM-only logic

### Live Sessions (SDK Integration)

`LiveSession` wraps the Claude Agent SDK `query()` call with an async generator for streaming multi-turn conversations. Key flow:
1. `getOrCreateLiveSession(key)` — reuses existing session or creates new one (with optional SDK session resume)
2. `session.send(text)` — sends a user message, returns the full assistant response
3. `runWithRetry(key, prompt)` — send with auto-retry on session errors (resets and retries once)

SDK session IDs are persisted in the session registry so conversations survive daemon restarts.

### Message Flow

1. Channel receives message → `agent.enqueueMessage()` (serialized per session key)
2. `handleMessage()` — allowlist check, identity resolution, timestamp injection
3. `runWithRetry()` → `LiveSession.send()` → SDK query → streamed response
4. Response sent back through channel (with streaming updates via `createStreamingMessage`)

### Sending Notifications (No Agent Query)

`agent.sendNotification(text)` sends a direct channel message without invoking Claude:
1. Tries `dm:` session via IdentityRouter
2. Falls back to first non-group session key from the registry
3. Uses `parseChannelKey()` to skip groups

Use this for system-level notifications (version updates, errors) that don't need AI processing.

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

Users ask Tomo to schedule things via chat. The agent uses a skill to CRUD jobs in `~/.tomo/data/cron/jobs.json`. The `CronScheduler` polls every 30s and fires due jobs via `agent.handleCronMessage()`, which delivers the response through the appropriate channel.

### LCM (Lifecycle Management)

Custom context compaction that operates on the SDK's JSONL session files directly:
- `compact.ts` — replaces a range of conversation events with a summary
- `stats.ts` — computes context usage breakdown
- `prune-tools.ts` — removes tool results to free context space

Compaction is triggered by the agent itself (via skill) when context usage exceeds 80%.

## Code Conventions

- ESM throughout (`"type": "module"` in package.json)
- TypeScript strict mode
- Imports use `.js` extensions (Node16 module resolution)
- Logging via `log` from `./logger.ts` (pino) — use `log.info`, `log.warn`, `log.error`, `log.debug`
- Tests in `tests/` using vitest — run with `npm test`
- No default exports — always named exports
