---
name: tomo-system
description: Check system status, debug issues, view session stats, manage sessions and cron jobs. Use when something isn't working, when asked about system internals, or when you need to check your own state.
---

# Tomo System Reference

## Status and Health

```bash
tomo status                    # Is daemon running? PID, uptime
tomo logs -n 20                # Recent log entries
tomo logs -n 50 | grep ERROR   # Recent errors
```

## Sessions

```bash
tomo sessions list             # All sessions with stats (queries, cost, context usage)
tomo sessions clear            # Unlink all sessions (30-day TTL before deletion)
tomo sessions clear <key>      # Unlink specific session (e.g. "telegram:12345")
```

Session stats show:
- **Queries**: total API calls in this session
- **Cost**: cumulative USD spent
- **Tokens**: total input/output tokens
- **Context**: current context window usage (X/200000)

**Note:** Context stats come from the SDK API and reflect the state at the end of the *previous* query. After compacting or other changes, you need to wait for a new query to complete before the numbers update.

Per-session model overrides live in `sessionModelOverrides` in `~/.tomo/config.json`. Users can set them from chat with `/model <name>`; Tomo persists the override for the current session, closes the live SDK process, and uses the selected model on the next turn. `tomo config` can also set or clear model overrides from the Sessions menu.

When context crosses the nudge threshold (default 70%, set via `lcm.nudgeAtPct` in config.json), the harness sends a system message asking you to run `tomo lcm daily` — see the `tomo-lcm` skill. A second nudge at 80% asks you to use the `lcm compact` skill before the next user message. A periodic rollup runner also nudges you when daily/weekly/monthly/yearly blocks are due. Group sessions default to SDK auto-compact instead (override with `lcm.groupCompactStyle: "lcm"` to enroll groups in all three nudges).

## Cron Jobs

Schedule reminders and recurring tasks via the `tomo-internal` MCP tools:

- `schedule_create` — create a one-shot or recurring job (`schedule` accepts `in 20m`, `every 6h`, or a 5-field cron expression; `sessionKey` controls where the fired message lands)
- `schedule_list` — list every job with `id`, `nextRunAt`, `lastStatus`, etc.
- `schedule_remove` — delete by `id`

These are the everyday interface — load them via tool search ("schedule reminder cron") when the user asks to schedule something.

The `tomo cron list / add / remove` CLI is still here for human debugging (auditing the job store, fixing a stuck job after a restart). Prefer the MCP tools in normal conversation.

## File Paths

| Path | Purpose |
|------|---------|
| `~/.tomo/config.json` | Configuration (channels, identities, model, session model overrides) |
| `~/.tomo/workspace/` | Agent working directory (cwd) |
| `~/.tomo/workspace/memory/` | Persistent memory files |
| `~/.tomo/workspace/memory/MEMORY.md` | Memory index (loaded every conversation) |
| `~/.tomo/workspace/tmp/` | Temp files (downloads, screenshots, etc.) |
| `~/.tomo/workspace/SOUL.md` | Personality config |
| `~/.tomo/workspace/AGENT.md` | Operating rules |
| `~/.tomo/workspace/IDENTITY.md` | Identity and preferences |
| `~/.tomo/data/sessions/` | Transcript logs and session registry |
| `~/.tomo/data/cron/jobs.json` | Scheduled tasks |
| `~/.tomo/logs/tomo.log` | Daemon logs |

## Config file

`~/.tomo/config.json` holds model, channels, identities, allowlists, session model overrides, and other settings. Prefer editing via `tomo config`; for the full field list, example JSON, and env-var overrides see [CONFIG.md](CONFIG.md). Manual edits require `tomo restart` to take effect; `/model <name>` persists and applies the current session override without a restart.

Before changing `~/.tomo/config.json` directly, copy the current file to `~/.tomo/config.json.bak`, then write the updated config. If the new config breaks Tomo while the harness is still reachable, the user can send `/restore` to copy `config.json.bak` back to `config.json` and restart.

## Harness Features

### Streaming
Responses stream to Telegram in real-time — messages update every 1.5s as tokens arrive.

### MEDIA: tag
To send an image/file to the user, include `MEDIA:/path/to/file.png` in your response. The harness strips it from text and sends the file. Text before/after becomes the caption.

### STICKER: tag
To send a Telegram sticker by file_id, include `STICKER:<telegram_file_id>` in your response. The harness strips it from text and sends the sticker on Telegram; other channels ignore sticker sends. Only use file_ids you have seen or been given.

### NO_REPLY
Reply with exactly `NO_REPLY` to suppress delivery to the channel. Use for background tasks that found nothing to report.

### Timestamps
Every message includes a timestamp prefix like `[Mon 04/07 14:30 PDT]` so you always know the current time.

### System messages
Messages prefixed with `System:` are from the harness (cron triggers, group context), not from a human.

### Group chats
Two listen modes per group:

- **Mention-required** (default for Telegram): you only receive messages that explicitly tag you. Respond as you would in a DM.
- **Passive** (default for iMessage; opt-in for Telegram via `channels.telegram.passiveGroups: ["<chatId>"]` in config.json): you see every message in the group without `@mention`. Reply only when genuinely useful — `NO_REPLY` to stay silent on chatter, greetings, or messages not directed at you.

The active mode plus group title and known participants are part of your per-session system prompt under `## Group Chat Context` whenever you're in a group session — survives compaction. Each incoming group message is prefixed with the sender name (`Alice: ...`) so you can attribute it.

### Proactive messaging (MCP tools)
In-process MCP tools let you message outside the current conversation:

- `mcp__tomo-internal__list_sessions` — discover valid targets. Returns `{identities: [{name}], groups: [{key, title?, participants?}]}`. Group titles and participants populate as messages arrive in the group; an entry without them just hasn't seen activity since the schema landed.
- `mcp__tomo-internal__send_message(target, message, mode?)` — send to a target. Two modes:
  - `delegate` (default): describe the *intent* (e.g. "follow up with Alice about her recent trip"). The recipient session's Claude composes the actual message in its own voice/context. Best for social or contextual relays. Fire-and-forget.
  - `direct`: send the verbatim text. Recipient is not triggered into a Claude turn. Best for factual broadcasts ("meeting moved to 3pm"), pasted content, or self-targeted mid-loop progress updates.
- `mcp__tomo-internal__rename_group_chat(target, title)` — rename the real Telegram or iMessage group title. Use only when the user explicitly asks for a rename; `target` must be a group session key from `list_sessions`.
- `mcp__tomo-internal__react_to_latest_message(target, reaction, remove?)` — react/tapback to the latest inbound message Tomo has seen in that session since startup. This latest-message state is in-memory; after a restart, wait for a new inbound message before using it. Usually pass the current Session key. Reactions: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`.

Pass identity name (`"alice"`) or session key (`"telegram:-1001234567"`) as `target`. Call `list_sessions` first if unsure. Tool result lines (with `is_error` flag) appear in `tomo logs` immediately after the corresponding tool call.

## Skills

### Built-in skills (`tomo-*`)
Skills prefixed with `tomo-` are bundled with Tomo and automatically updated on every `tomo start`. Do not edit these — your changes will be overwritten on next restart.

Current built-in skills: `tomo-system`, `tomo-lcm`, `tomo-browse`.

### Custom / third-party skills
Place skill directories under `~/.tomo/workspace/.claude/skills/`. Each skill needs a `SKILL.md` with YAML frontmatter (`name` and `description`). The harness picks them up automatically — restart Tomo to load new skills.

```
~/.tomo/workspace/.claude/skills/
├── tomo-system/       # built-in (auto-updated)
├── tomo-lcm/          # built-in (auto-updated)
├── my-custom-skill/   # user-managed (never overwritten)
│   └── SKILL.md
```

Avoid the `tomo-` prefix for custom skills so they won't conflict with built-in updates.

## Update

```bash
tomo update              # Check for new version, install it, and restart
```

Checks the npm registry, runs `npm install -g tomo-ai@latest`, and restarts the daemon automatically.

## Backup

```bash
tomo backup              # Create a backup (config, workspace, data, SDK sessions)
tomo backup list         # List existing backups
tomo backup restore <id> # Restore from a backup (daemon must be stopped first)
```

Backups are stored in `~/Backups/tomo/` with 14-day rolling retention.

## Troubleshooting

### Agent not responding
```bash
tomo status          # Check if running
tomo logs -n 20      # Check for errors
tomo restart         # Restart
```

### Session feels stale or confused
```bash
tomo sessions clear  # Reset sessions (Must ask user to confirm)
tomo restart
```
Or tell the user to send `/new` in Telegram.

### Cron jobs not firing
```bash
tomo cron list       # Check nextRunAt and lastStatus
tomo logs | grep Cron
```
Jobs are checked every 30 seconds. Jobs created via CLI are picked up on the next tick.

### Context window full
Check with `tomo sessions list`. DM sessions and any group with `lcm.groupCompactStyle: "lcm"` rely on the harness nudging you to run `tomo lcm daily` / the `lcm compact` skill — SDK auto-compact is off for them. Other groups fall back to SDK auto-compact near 100%. If stuck, `/new` starts a fresh session.

### Memory not loading
Memory is read from `~/.tomo/workspace/memory/MEMORY.md` at the start of every query. Check the file exists and has content:
```bash
cat ~/.tomo/workspace/memory/MEMORY.md
```
