<p align="center">
  <h1 align="center">Tomo</h1>
  <p align="center">A personal AI assistant that lives in your messaging apps.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tomo-ai"><img src="https://img.shields.io/npm/v/tomo-ai.svg" alt="npm version"></a>
  <a href="https://github.com/shuaiyuan17/tomo/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/tomo-ai.svg" alt="license"></a>
  <a href="https://github.com/shuaiyuan17/tomo/actions/workflows/ci.yml"><img src="https://github.com/shuaiyuan17/tomo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  Powered by <a href="https://platform.claude.com/docs/en/agent-sdk/overview">Claude Agent SDK</a> &middot;
  Personality system &middot;
  Persistent memory &middot;
  Scheduled tasks &middot;
  Telegram &middot; iMessage
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
- At least one channel:
  - **Telegram** — bot token from [@BotFather](https://t.me/BotFather)
  - **iMessage** — [BlueBubbles](https://bluebubbles.app) server running on a Mac with iMessage signed in

## CLI

```bash
tomo init              # First-time setup
tomo config            # Interactive settings (model, channels, identities, groups)
tomo start             # Start in background (daemon)
tomo start -f          # Start in foreground (for dev)
tomo stop              # Stop the daemon
tomo restart           # Restart the daemon
tomo status            # Show PID and uptime
tomo logs              # View logs (pretty-printed)
tomo logs -f           # Follow logs live
tomo sessions list     # Show active sessions
tomo sessions clear    # Reset all sessions
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation (resets session) |
| `/model` | Switch model (sonnet/opus/haiku) |

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
- **iMessage** — via [BlueBubbles](https://bluebubbles.app)
  - DM and group chat support
  - Image attachment support
  - Contact name resolution from Mac contacts
  - Group chat: observes all messages, only responds when relevant (replies `NO_REPLY` to stay silent)

### Multi-Channel Sessions

Talk to Tomo from multiple channels using the same session. Configure identities in `tomo config` to bind your Telegram and iMessage accounts — Tomo replies on whichever channel you last used (or a fixed default).

- DM sessions are unified across channels per identity
- Group chats always get their own isolated session
- Per-channel allowlists control who can message Tomo
- Group chats require a secret passphrase to activate (configured in `tomo config`)

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

Tomo can create scheduled tasks on its own — just ask "remind me in 30 minutes to stretch" or "check the weather every morning at 9am." Supports one-shot reminders, recurring intervals, and cron expressions.

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
  config.json                 # Channels, identities, model, settings
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

Run `tomo config` for interactive setup, or edit `~/.tomo/config.json` directly:

```json
{
  "channels": {
    "telegram": { "token": "your-bot-token", "allowlist": ["123456789"] },
    "imessage": { "url": "http://localhost:1234", "password": "...", "allowlist": ["+15551234567"] }
  },
  "identities": [
    {
      "name": "yourname",
      "channels": { "telegram": "123456789", "imessage": "+15551234567" },
      "replyPolicy": "last-active"
    }
  ],
  "model": "claude-sonnet-4-6",
  "groupSecret": "tomo-xxxxxxxx"
}
```

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Override Telegram token |
| `IMESSAGE_URL` | Override BlueBubbles URL |
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
