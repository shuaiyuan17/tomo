# Changelog

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
