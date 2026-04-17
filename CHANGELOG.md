# Changelog

## 0.4.0 (2026-04-17)

### Features

- **Hierarchical block rollups for LCM**. New `tomo lcm daily|weekly|monthly|yearly` subcommands auto-resolve the calendar period and event range, tagging each summary with a canonical `blockTag` (e.g. `daily 2026-04-17`, `weekly 2026-W16`, `monthly 2026-04`, `yearly 2026`). Each level consumes the one below — weekly rolls up 7 daily blocks into one, monthly consumes weeklies, yearly consumes monthlies. Steady state for a long-running session is bounded at ~30 summaries regardless of age.
- **Rebuild semantics on daily blocks**. Running `tomo lcm daily` mid-day replaces the existing `daily YYYY-MM-DD` block with a fresh summary that absorbs any new raw events since the last write. Safe to run multiple times per day.
- **Automatic promotion detection**. A new `RollupRunner` scans active sessions hourly (daytime only) for completed calendar units with un-promoted children. When found, it injects a `System:` nudge to the agent describing which rollup commands to run. Idempotent — catches missed Mondays on Tue/Wed.
- **Hot-tail cap hysteresis**. After each turn, if today's raw (non-summary) event count exceeds 40, the harness nudges the agent to run `tomo lcm daily` to compress. Debounced at a low-water mark of 24 so it doesn't thrash.
- **New skill docs** (`defaults/skills/lcm/SKILL.md`, `DAILY.md`, `WEEKLY.md`, `MONTHLY.md`, `YEARLY.md`) explaining the block-rollup mental model and style guidance per level. The time-range `compact` command is now documented as an escape hatch for surgical middle-range compactions.

## 0.3.10 (2026-04-17)

### Bug fixes

- `lcm compact`: archive compacted events to `_archive_<sdkSessionId>.jsonl` always, matching `store.searchArchive()` and `prune-tools`. Previously when `--channel-key` was passed the archive went to `<channelKey>.jsonl`, colliding with the live transcript namespace (e.g. `dm:shuai.jsonl` next to `dm_shuai.jsonl` — two files, different schemas, same directory).

## 0.3.9 (2026-04-17)

### Bug fixes

- `lcm compact`: re-parent every post-range event whose `parentUuid` pointed into the removed range, not just the first one. Previously only the first post-range user/assistant event was re-linked to the summary, leaving any sibling events (tool chains, split assistant content blocks, attachments) orphaned. On SDK resume those broken links caused the chain walker to skip the compact summary entirely — summaries were written to disk but never reached the API.
- `tomo restart`: wait for the old PID to exit and a new one to come up (up to 60s) before reporting success, and fall back to a direct SIGTERM if the running tomo wasn't actually the launchd-managed instance. Previously `launchctl kickstart -k` returned immediately; the CLI printed success while the old process was still draining, and in some cases the signal never reached it at all.

### Other

- `scripts/`: add one-shot session recovery utilities (`repair-session.ts`, `prune-session.ts`, `compact-session.ts`) for sessions that got damaged by the pre-fix compactor or grew too big to resume through the agent.

## 0.3.8 (2026-04-16)

### Features

- Default Opus model upgraded from Claude Opus 4.6 to Claude Opus 4.7 (#45).

### Bug fixes

- Message isolation: user messages, cron triggers, and continuity heartbeats now share a single FIFO queue per session. Previously only user messages were serialized, which let concurrent cron/heartbeat ingress stomp on an in-flight user turn's `currentRequest` slot inside `LiveSession` and cause response hijacking + 5-minute timeouts.
- Bump per-`send()` timeout 5m → 10m to accommodate longer tool-using turns.

## 0.3.7 (2026-04-12)

### Features

- `tomo update` — check for new versions, install, and restart in one command
- `tomo config` — add cost analysis view with per-session spending breakdown (#43)
- Version notification now tells users to run `tomo update` instead of manual npm commands

### Other

- Add code coverage and CodeQL security scanning (#42)
- Add `.nvmrc` for consistent Node version
- Add Dependabot for weekly dependency updates (#36)
- Bump commander 13.1.0 → 14.0.3, pino 9.14.0 → 10.3.1, croner 9.1.0 → 10.0.1, @anthropic-ai/claude-agent-sdk 0.2.92 → 0.2.104
- Fix npm publish workflow for OIDC trusted publishing (#31, #32, #33, #35)

## 0.3.6 (2026-04-11)

### Features

- `tomo backup` — create, list, and restore backups of config, workspace, data, and SDK session files
- 14-day rolling retention, atomic writes (`.tmp` + rename), and custom skills included in backups
- Restore blocks while daemon is running and preserves `.claude/` directory
- Backup commands documented in `tomo-system` skill

## 0.3.5 (2026-04-10)

### Features

- Cron jobs now target a single required `--session <key>` flag instead of `--channel`/`--chat-id`, so the agent can schedule reminders that fire back to any session — DM, unified identity (`dm:<name>`), or group chat — just by passing the `Session key` from its system prompt
- Agent's system prompt now shows `Session key: <key>` under the SESSION block (was `Channel key`)
- Identity changes in `tomo config` eagerly rewrite matching cron jobs: creating or editing an identity moves per-channel cron jobs onto `dm:<name>`, and removing an identity moves them back to a concrete per-channel key — no stale pointers after migration
- New `IdentityRouter.deriveReplyTargetFromConfig` fallback lets a `dm:*` cron fire correctly even before the identity has ever received a message (derives the reply target from `replyPolicy` + `identity.channels`)
- Commit and PR attribution via the SDK's native `settings.attribution` field — tomo now stamps `Made by [Tomo](https://github.com/shuaiyuan17/tomo)` on commits and PRs it creates
- New `tomo-system/CONFIG.md` level-2 skill reference: full `~/.tomo/config.json` example with every supported field, type table, `replyPolicy` options, env-var overrides
- `tomo-cron` skill doc explains where reminders get delivered and when to pass `--session $SESSION_KEY` (the "remind me" vs "remind us" heuristic)

### Bug fixes

- `tomo restart` now recovers when the LaunchAgent plist is on disk but the service isn't loaded (e.g. after `tomo stop`) — `kickstart` falls through to `bootstrap` automatically instead of failing with `Could not find service`
- `tomo restart` with autostart disabled now returns a clear `Autostart is not enabled…` error instead of a raw launchctl failure

## 0.3.4 (2026-04-09)

### Features

- Start Tomo automatically when you log in (macOS) via a LaunchAgent at `~/Library/LaunchAgents/ai.tomo.plist`
- Prompt to enable autostart during `tomo init`; toggle later from `tomo config` → Autostart
- Add `tomo uninstall` command that stops the service and removes the login-item (keeps `~/.tomo/` data)

### Bug fixes

- `tomo stop` and `tomo restart` now route through `launchctl` when autostart is enabled, instead of killing the pidfile'd process (which `KeepAlive` would have respawned)

## 0.3.3 (2026-04-09)

### Features

- Add startup disclaimer about AI risks, prompt injection, and allowlist hygiene
- Prune base64 images in `prune-tools` LCM tool

### Bug fixes

- `prune-tools` now prunes `toolUseResult` previews and triggers a session reload after pruning

## 0.3.2 (2026-04-09)

### Features

- Channel-aware timestamps in session context
- `/status` command
- `prune-tools` LCM tool for trimming tool-result bloat
- Skill auto-sync on startup (defaults copied over on upgrade)
- ASCII banner

### Bug fixes

- Improve auth check error message to mention usage limits

## 0.3.1 (2026-04-09)

### Bug fixes

- Lazy-load config in the `lcm` CLI so `init` and `status` don't crash on fresh installs
- Fix compaction session reload by using the SDK's `close()` method
- Fix Telegram flush race condition and expand test coverage
- Clarify context stats timing in `lcm` and system skills

## 0.3.0 (2026-04-08)

### Features

- iMessage support via BlueBubbles, with multi-channel session routing
- Per-channel allowlists to restrict who can message Tomo
- Group chat support with activation via a secret passphrase
- Interactive `tomo config` TUI for managing settings
- Collect Telegram user ID during `tomo init` and manage the allowlist from the TUI
- Resolve iMessage sender addresses to contact names
- Per-session message queue to prevent LiveSession contention
- Config TUI: session picker when binding DM chat IDs, and all 5 model variants listed (including 1M context)
- Default model is now Sonnet 4.6 (non-1M) for new users

### Bug fixes

- Match iMessage allowlist and identity entries by phone number or email
- Normalize identity session keys to lowercase
- iMessage groups: skip typing indicator and suppress error messages
- iMessage groups: treat all messages as mentioned with silence guidance

## 0.2.1 (2026-04-08)

### Features

- Add context window breakdown by category to session metadata
- Auto-nudge agent to compact when context hits 80%

### Bug fixes

- Surface API errors to Telegram instead of silently swallowing
- Split cost log into per-turn and cumulative session total
- Fix totalCostUsd double-counting in session stats

## 0.2.0 (2026-04-08)

### Features

- Add LCM (Long Context Management) tools for context compaction and archive search
- Enable 1M context window beta support
- Auto-reload session after compact
- Add `migrate` command

### Bug fixes

- Auto-restart Telegram polling when it dies silently
- Fix image support and add timeout
- Always overwrite default skills on startup

### Other

- Update browse skill: headed mode, persistent profile, named session

## 0.1.4 (2026-04-07)

### Features

- Streaming input mode with session stats
- Add continuity heartbeat system
- Add media sending and browser skill
- Add `/model` command and proactive memory
- Auto-sync default skills and files on startup

### Bug fixes

- Fix `MEDIA:` tag showing in streamed messages

### Other

- Add GitHub Actions CI (Node 22 & 24)

## 0.1.0 (2026-04-06)

Initial release.
