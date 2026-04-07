# Tomo

A personal assistant that lives in your messaging apps. Powered by [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).

Tomo has its own personality, remembers things across conversations, can use tools autonomously, and runs scheduled tasks — all through a simple CLI.

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

### Channels
- **Telegram** — DM and group chat support
  - Typing indicators with keepalive and error backoff
  - Image/photo support (sends to Claude as vision input)
  - Group chat: only responds when @mentioned or replied to, tracks participants
  - Markdown rendering with plain-text fallback

### Personality
Three markdown files define who your assistant is, all customizable:
- **SOUL.md** — Core personality and values
- **AGENT.md** — Operating rules and response style
- **IDENTITY.md** — Name, vibe, preferences

During `tomo init`, you choose a name, your preferred name, and a tone (chill/sharp/warm). These get baked into the templates. Edit them anytime — changes take effect on the next message, no restart needed.

### Memory
File-based persistent memory at `~/.tomo/workspace/memory/`:
- **MEMORY.md** index is injected into every conversation
- Tomo reads and writes memory files autonomously
- Remembers who you are, your preferences, and past context across sessions

### Tools
Tomo has access to Claude's built-in tools:
- File operations (Read, Write, Edit, Glob, Grep)
- Shell commands (Bash)
- Web access (WebSearch, WebFetch)
- Subagents for complex tasks (Agent)
- Skills for specialized workflows (Skill)

### Skills
Markdown-based skills that teach Tomo specialized abilities. Ships with:
- **tomo-cron** — Create and manage scheduled tasks and reminders

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

Jobs that find nothing to report reply silently (`NO_REPLY`) without messaging you.

### Sessions
- Multi-turn conversations via Claude Agent SDK session resume
- Persistent across restarts
- `/new` command in Telegram to start fresh
- Unlinked sessions kept for 30 days before cleanup

### Logging
Structured logs via pino with:
- Tool call summaries
- Token usage and cost per message
- Context window tracking with compaction warnings

## Project Structure

```
src/
  cli.ts                  # CLI entry point
  cli/
    init.ts               # tomo init (onboarding)
    start.ts              # tomo start (foreground + daemon)
    daemon.ts             # tomo stop/restart/status/logs
    cron.ts               # tomo cron subcommands
    sessions.ts           # tomo sessions subcommands
  agent.ts                # Core agent — message handling, SDK integration
  config.ts               # Configuration (~/.tomo/config.json)
  logger.ts               # Pino structured logging
  channels/
    types.ts              # Channel interface
    telegram.ts           # Telegram implementation (grammY)
  sessions/
    types.ts              # Session types and registry
    store.ts              # Session persistence and lifecycle
  cron/
    types.ts              # Cron job data model
    store.ts              # Job persistence and scheduling
    scheduler.ts          # Timer loop and execution
  workspace/
    SOUL.md               # Default personality (dev)
    AGENT.md              # Default operating rules (dev)
    IDENTITY.md           # Default identity (dev)
    index.ts              # System prompt builder
defaults/                 # Templates copied by tomo init
  SOUL.md
  AGENT.md
  IDENTITY.md
  skills/cron/SKILL.md
```

## File Layout (after `tomo init`)

```
~/.tomo/
  config.json                 # Telegram token, model
  tomo.pid                    # PID file (when running)
  workspace/
    SOUL.md                   # Your personality config
    AGENT.md                  # Your operating rules
    IDENTITY.md               # Your identity config
    memory/
      MEMORY.md               # Memory index
    .claude/skills/           # Skills for SDK discovery
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
| `LOG_LEVEL` | Log level (default: debug) |

## Development

```bash
git clone <repo> && cd tomo
npm install
npm run dev    # Foreground with hot reload
```

## License

MIT
