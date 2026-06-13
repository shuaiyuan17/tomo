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

- Node.js 22.12+
- [Claude Code](https://claude.com/claude-code) installed. Authenticate Claude Code for direct Claude models, or configure a LiteLLM gateway for non-Claude backends.
- At least one channel:
  - **Telegram** — bot token from [@BotFather](https://t.me/BotFather)
  - **iMessage** — [BlueBubbles](https://bluebubbles.app) server running on a Mac with iMessage signed in

## CLI

```bash
tomo init              # First-time setup
tomo config            # Interactive settings (model, LiteLLM, channels, identities, groups)
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
| `/model` | Switch model (Claude aliases or LiteLLM `provider/model` names) |
| `/restore` | Restore `config.json` from `config.json.bak` and restart |
| `/status` | Show session info (model, channel, message count) |

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
  - Group chat: defaults to mention-required (only responds when @mentioned or replied to); per-group passive listen mode opt-in via `channels.telegram.passiveGroups`
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
| TodoWrite | Task tracking within a turn |
| NotebookEdit | Edit Jupyter notebooks |
| `send_message` (MCP) | Proactively send a message to another session/identity |
| `list_sessions` (MCP) | List active identities and group sessions |

### External MCP Servers

Add remote or local MCP servers directly to `~/.tomo/config.json` under `mcpServers`. Tomo passes them through to the Claude Agent SDK and, by default, auto-allows all tools from each configured server with `mcp__<server>__*`.

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://code.claude.com/docs/mcp"
    },
    "github": {
      "type": "sse",
      "url": "https://api.example.com/mcp/sse",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    },
    "github-copilot": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "oauth": {
        "scopes": ["read:user"],
        "tokenStoreKey": "github-copilot"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/Projects"]
    }
  }
}
```

Use `type: "http"` for streamable HTTP, `type: "sse"` for SSE, or omit `type` for stdio servers. Environment variables in `url`, `headers`, `env`, and `args` are expanded at runtime. To restrict auto-approval, set top-level `mcpAllowedTools`, for example `["mcp__github__list_issues"]`.

Remote HTTP/SSE servers can also use harness-managed OAuth by adding an `oauth` block. Tomo discovers the authorization server from the MCP server's RFC 9728 `WWW-Authenticate` challenge unless `authorizationServer` is set explicitly, uses authorization-code + PKCE, registers a dynamic client when needed, stores tokens in `~/.tomo/workspace/secrets/mcp-oauth.json` with mode `0600`, silently refreshes near-expiry tokens, and injects `Authorization: Bearer <token>` into MCP headers. The agent never sees the tokens.

If browser login is needed, Tomo forwards the authorize URL to your private chat and waits for the localhost callback before starting the agent session.

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
    "telegram": {
      "token": "your-bot-token",
      "allowlist": ["123456789"],
      "passiveGroups": ["-1001234567890"]
    },
    "imessage": { "url": "http://localhost:1234", "password": "...", "allowlist": ["+15551234567"] }
  },
  "identities": [
    {
      "name": "yourname",
      "channels": { "telegram": "123456789", "imessage": "+15551234567" },
      "replyPolicy": "last-active"
    }
  ],
  "model": "claude-sonnet-4-6[1m]",
  "litellm": {
    "mode": "chatgpt-subscription",
    "baseUrl": "http://localhost:4000",
    "apiKey": "sk-tomo-local"
  },
  "maxTurns": 50,
  "saveInboundImages": true,
  "continuity": true,
  "continuityScript": {
    "path": "~/bin/tomo-continuity.sh",
    "timeoutMs": 30000,
    "maxOutputChars": 8000
  },
  "groupSecret": "tomo-xxxxxxxx",
  "lcm": {
    "nudgeAtPct": 70,
    "nudgeResetPct": 60,
    "groupCompactStyle": "lcm"
  }
}
```

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Override Telegram token |
| `IMESSAGE_URL` | Override BlueBubbles URL |
| `CLAUDE_MODEL` | Override model |
| `TOMO_LITELLM_BASE_URL` | Route Claude Agent SDK model calls through a LiteLLM proxy |
| `TOMO_LITELLM_API_KEY` | API key sent to the LiteLLM proxy as `ANTHROPIC_API_KEY` |
| `TOMO_LITELLM_MODE` | Optional LiteLLM mode: `anthropic-compatible` or `chatgpt-subscription` |
| `TOMO_WORKSPACE` | Override workspace directory |
| `TOMO_MAX_TURNS` | Override per-turn tool-use ceiling (default: `50`) |
| `TOMO_STEERING` | Override message steering. Defaults to `true`; set `false` to keep mid-turn messages queued. |
| `TOMO_CONTINUITY_SCRIPT` | Override the optional continuity script path |
| `TOMO_CONTINUITY_SCRIPT_TIMEOUT_MS` | Override continuity script timeout (default: `30000`) |
| `TOMO_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS` | Override continuity script stdout/stderr cap (default: `8000`) |
| `LOG_LEVEL` | Log level (default: `debug`) |

`continuityScript` can also be a simple path string, e.g. `"continuityScript": "~/bin/tomo-continuity.sh"`. Relative paths resolve under `~/.tomo`; the script runs once per scheduled heartbeat and manual `tomo continuity` trigger, and its stdout/stderr or failure status is appended to the normal continuity prompt.

### Steering

By default, messages you send while Tomo is mid-task are steered into the in-flight turn at the next tool-call boundary — so "stop", "wait", or extra context reaches the model immediately instead of waiting for the current turn to finish. If the turn has no tool calls left, the message runs as its own follow-up turn right after. iMessage fragment settling still applies before injection; system-originated turns (cron, continuity) keep their normal queued behavior. Set `"steering": false` or `TOMO_STEERING=false` to keep mid-turn messages queued behind the active turn.

### LiteLLM / ChatGPT Subscription Models

Tomo still runs through Claude Agent SDK, but you can point the SDK at a local LiteLLM proxy and select a LiteLLM model name such as `chatgpt/gpt-5.5`. This keeps Tomo's Claude SDK sessions, memory, workspace, MCP tools, and LCM behavior while LiteLLM translates Anthropic `/v1/messages` streaming calls to the ChatGPT subscription backend.

```yaml
# ~/litellm-chatgpt.yaml
environment_variables:
  CHATGPT_DEFAULT_INSTRUCTIONS: >-
    Follow the instructions supplied in this request.

model_list:
  - model_name: chatgpt/gpt-5.5
    model_info:
      mode: responses
    litellm_params:
      model: chatgpt/gpt-5.5

litellm_settings:
  drop_params: true

general_settings:
  master_key: sk-tomo-local
```

```bash
litellm --config ~/litellm-chatgpt.yaml
tomo config   # LiteLLM gateway -> ChatGPT subscription
```

Then set the default model to `chatgpt/gpt-5.5` from `tomo config`, or use `/model chatgpt/gpt-5.5` in a chat. LiteLLM owns the ChatGPT OAuth device flow and token storage; Tomo only sends Anthropic-compatible requests to the local proxy.

If LiteLLM returns `System messages are not allowed`, use a LiteLLM build that includes ChatGPT system-role normalization. If non-streaming curl checks fail while streaming `/v1/messages` works, that is still compatible with Tomo because Claude Agent SDK uses streaming.

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
