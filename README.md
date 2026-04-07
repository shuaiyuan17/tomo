<p align="center">
  <h1 align="center">Tomo</h1>
  <p align="center">A personal AI assistant that lives in your messaging apps.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tomo-ai"><img src="https://img.shields.io/npm/v/tomo-ai.svg" alt="npm version"></a>
  <a href="https://github.com/shuaiyuan17/tomo/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/tomo-ai.svg" alt="license"></a>
  <a href="https://www.npmjs.com/package/tomo-ai"><img src="https://img.shields.io/npm/dm/tomo-ai.svg" alt="downloads"></a>
  <a href="https://github.com/shuaiyuan17/tomo"><img src="https://img.shields.io/github/stars/shuaiyuan17/tomo.svg?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  Powered by <a href="https://platform.claude.com/docs/en/agent-sdk/overview">Claude Agent SDK</a> &middot;
  Personality system &middot;
  Persistent memory &middot;
  Scheduled tasks &middot;
  Telegram (more channels coming)
</p>

---

## Quick Start

```bash
npm install -g tomo-ai
tomo init       # Set up config, pick a name and personality
tomo start      # Runs in background
```

That's it. Open Telegram and message your bot.

## Requirements

- Node.js 22+
- [Claude Code](https://claude.com/claude-code) installed and authenticated (subscription plan — API keys are not currently supported)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))

## CLI

```bash
tomo init              # First-time setup
tomo start             # Start in background (daemon)
tomo start -f          # Start in foreground (for dev)
tomo stop              # Stop the daemon
tomo restart           # Restart the daemon
tomo status            # Show PID and uptime
tomo logs              # View logs (pretty-printed)
tomo logs -f           # Follow logs live
tomo sessions list     # Show active sessions
tomo sessions clear    # Reset all sessions
tomo cron add          # Create a scheduled task
tomo cron list         # List all jobs
tomo cron remove <id>  # Delete a job
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation (resets session) |

## Features

### Personality

Three markdown files define who your assistant is, all customizable:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality, values, communication style |
| `AGENT.md` | Operating rules, response format, behavior |
| `IDENTITY.md` | Name, vibe, preferences, quirks |

During `tomo init`, you choose a name, your preferred name, and a tone (chill / sharp / warm). These get baked into the templates. Edit them anytime — changes take effect on the next message, no restart needed.

### Memory

File-based persistent memory at `~/.tomo/workspace/memory/`. The `MEMORY.md` index is injected into every conversation. Tomo reads and writes memory files autonomously — it remembers who you are, your preferences, and past context across sessions.

### Channels

- **Telegram** — DM and group chat support
  - Typing indicators with keepalive and error backoff
  - Image/photo support (sends to Claude as vision input)
  - Group chat: only responds when @mentioned or replied to, tracks participants
  - Markdown rendering with plain-text fallback
- More channels coming (iMessage, Discord, etc.)

### Tools

Tomo has access to Claude's built-in tools:

| Tool | Capability |
|------|-----------|
| Read, Write, Edit | File operations |
| Bash | Shell commands |
| Glob, Grep | File search |
| WebSearch, WebFetch | Web access |
| Agent | Subagents for complex tasks |
| Skill | Specialized workflows |

### Scheduled Tasks

```bash
# One-shot reminder
tomo cron add --name "standup" --schedule "in 20m" --message "Time for standup!"

# Recurring task
tomo cron add --name "morning" --schedule "0 9 * * *" --message "Check calendar and weather"

# Interval
tomo cron add --name "check" --schedule "every 2h" --message "Check email inbox"
```

Tomo can also create jobs itself — just ask "remind me in 30 minutes to stretch."

| Format | Type | Example |
|--------|------|---------|
| `in Xm/h/d` | One-shot | `in 30m`, `in 2h` |
| `every Xm/h` | Recurring interval | `every 30m` |
| Cron expression | Recurring (5-field) | `0 9 * * *` |

### Sessions

- Multi-turn conversations via Claude Agent SDK session resume
- Persistent across restarts
- `/new` in Telegram to start fresh
- Unlinked sessions kept for 30 days before cleanup

### Logging

Structured logs via [pino](https://github.com/pinojs/pino):
- Tool call summaries
- Token usage and cost per message
- Context window tracking with compaction warnings

## Architecture

```
~/.tomo/
  config.json                 # Telegram token, model
  tomo.pid                    # PID file (when running)
  workspace/
    SOUL.md                   # Your personality config
    AGENT.md                  # Your operating rules
    IDENTITY.md               # Your identity config
    memory/                   # Persistent memory files
    .claude/skills/           # Agent skills
  data/
    cron/jobs.json            # Scheduled tasks
    sessions/                 # Transcript logs and session registry
  logs/
    tomo.log                  # Daemon logs
```

## Configuration

Config lives at `~/.tomo/config.json`:

```json
{
  "channels": {
    "telegram": { "token": "your-bot-token" }
  },
  "model": "claude-sonnet-4-6"
}
```

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Override Telegram token |
| `CLAUDE_MODEL` | Override model |
| `TOMO_WORKSPACE` | Override workspace directory |
| `LOG_LEVEL` | Log level (default: `debug`) |

## Development

```bash
git clone https://github.com/shuaiyuan17/tomo.git && cd tomo
npm install
npm run dev    # Foreground with hot reload
```

## Contributing

Issues and pull requests welcome at [github.com/shuaiyuan17/tomo](https://github.com/shuaiyuan17/tomo).

## License

[MIT](LICENSE)
