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
- [Claude Code](https://claude.com/claude-code) installed. Direct Claude models can use a Claude subscription or an Anthropic API key; LiteLLM gateways support other backends.
- At least one channel:
  - **Telegram** — bot token from [@BotFather](https://t.me/BotFather)
  - **iMessage** — the [imsg CLI](https://github.com/openclaw/imsg) on a Mac with iMessage signed in (Tomo needs Full Disk Access)

## CLI

```bash
tomo init              # First-time setup
tomo config            # Interactive settings (authentication, model, LiteLLM, channels, identities, groups)
tomo start             # Start in background (daemon)
tomo start -f          # Start in foreground (for dev)
tomo stop              # Stop the daemon
tomo restart           # Restart the daemon
tomo restart --reason "..."  # Restart and tell the agent why afterward
tomo status            # Show PID and uptime
tomo logs              # View logs (pretty-printed)
tomo logs -f           # Follow logs live
tomo sessions list     # Show active sessions
tomo sessions clear [key]  # Unlink one session (or all sessions)
tomo cron              # Manage scheduled tasks (add / list / remove / run <id>)
tomo continuity        # Manually trigger a continuity heartbeat
tomo lcm               # Context tools (stats / blocks / compact / search / prune-tools / rollups)
tomo backup            # Back up all Tomo data (create / list / restore <date>)
tomo migrate           # Import conversation history from other platforms (openclaw <file>)
tomo update            # Update Tomo to the latest version and restart
tomo uninstall         # Stop Tomo and remove the login item (keeps your data)
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation (resets session) |
| `/model` | Switch model (Claude aliases, direct model IDs, or LiteLLM `provider/model` names) |
| `/restore` | Restore `config.json` from `config.json.bak` and restart |
| `/login` | Refresh Claude login from a configured owner's private DM (`/login cancel` aborts a pending login) |
| `/mcp` | Show external MCP health; `/mcp login <server>` starts per-server OAuth (owner DM only) |
| `/status` | Show session info (model, channel, message count) |
| `/cost` | Show current-session cost for 1d / 7d / 1mo |
| `/usage` | Show Claude subscription usage limits (5-hour and weekly windows + reset countdowns) |
| `/pet` | Check Tomo's pet's mood, growth stage, and stats |
| `/summon` | (groups) Pull your main DM session into this group temporarily |
| `/dismiss` | (groups) Hand the group back to its own Tomo session |

**Summon** — `/summon` in a group routes that group's messages into your main `dm:` session, so Tomo answers with your full personal context. Group-facing replies go through an explicit `send_message` direct call; plain output stays in your private DM. `/dismiss` hands back, and the summon auto-expires after `summonExpiryMinutes` (default 60) of group inactivity.

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

Beyond memory files, the `recall_conversation` tool lets Tomo search a session's full message history — including everything compacted out of its context window or archived to monthly transcript files.

### People Registry

Tomo keeps person records at `~/.tomo/workspace/memory/people/*.md` — canonical name, aliases/nicknames, and per-channel handles in frontmatter, freeform notes below. Group messages are annotated with the sender's resolved name, and handles auto-bind the first time a sender's display name matches a record — you only ever refer to people by name. Records meant for your eyes only live under `memory/private/people/` and never enter group chats. Tomo maintains the registry itself via the `list_people` / `upsert_person` tools.

### Channels

- **Telegram** — DM and group chat support
  - Typing indicators with keepalive and error backoff
  - Image/photo support (sends to Claude as vision input)
  - Group chat: defaults to mention-required (only responds when @mentioned or replied to); per-group passive listen mode opt-in via `channels.telegram.passiveGroups`
  - Markdown rendering with plain-text fallback
- **iMessage** — via the local [imsg CLI](https://github.com/openclaw/imsg), enabled with `channels.imessage.provider: "imsg"`
  - DM and group chat support
  - Image attachment support
  - Contact name resolution from Mac contacts
  - Group chat: observes all messages, only responds when relevant (replies `NO_REPLY` to stay silent)
  - imsg provider: no external server — Tomo spawns one `imsg rpc` child (needs Full Disk Access); adds inbound tapbacks and built-in reply context, and gates message editing on a live macOS selector probe

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

Plus a built-in `tomo-internal` MCP server:

| Group | Tool | Capability |
|-------|------|-----------|
| Messaging | `send_message` | Message another session — `delegate` mode (recipient's Claude composes) or `direct` mode (verbatim text) |
| | `list_sessions` | List identities and active group chats (titles, participants) |
| | `rename_group_chat` | Rename a real Telegram/iMessage group chat |
| | `react_to_message` | React/tapback to a message in a session — latest inbound by default, or matched by text |
| Scheduling | `schedule_create` / `schedule_list` / `schedule_remove` | Manage scheduled tasks (one-shot, interval, or cron) |
| People | `list_people` / `upsert_person` | Read and maintain the people registry |
| History | `recall_conversation` | Search the session's full history, including compacted and archived messages |
| Pet | `pet_status` / `pet_hatch` / `pet_feed` / `pet_play` / `pet_sleep` | Care for Tomo's virtual pet |

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

If browser login is needed, Tomo forwards the authorize URL to your private chat without blocking the agent session. When the browser is on another device and its localhost redirect cannot reach the Tomo host, paste the full redirect URL back into the configured owner's private DM; Tomo matches its single-use `state`, exchanges the code with the server-side PKCE verifier, and stores the resulting token. Once authentication succeeds, Tomo hot-mounts the server into live sessions through the Agent SDK without waiting for a restart or another session cycle; older SDKs and rejected runtime updates safely fall back to mounting it in the next session. `/mcp` shows configured servers, per-session mount state, token expiry, pending authorization, and the latest auth failure; `/mcp login <server>` starts or reuses one background flow for that server.

### Claude Code Plugins

Tomo can load [Claude Code plugins](https://code.claude.com/docs/en/agent-sdk/plugins) — bundles of skills, agents, slash commands, hooks, and MCP servers — into every session. Add a top-level `plugins` array to `~/.tomo/config.json`:

```json
{
  "plugins": [
    "~/my-plugins/deploy-tools",
    "code-reviewer@claude-plugins-official",
    "linear",
    { "path": "./relative/plugin", "skipMcpDiscovery": true }
  ]
}
```

Entries can be:

- **Local paths** (`~/x`, `./x`, `/x`) — the plugin root directory (the parent of `skills/`, `agents/`, `.claude-plugin/`). Relative paths resolve against `~/.tomo`, not the daemon's working directory.
- **Installed plugin refs** — plugins you already installed with `claude plugin marketplace add ...` + `claude plugin install ...`. Use the full `name@marketplace` id, or the bare name when it's unambiguous. Tomo resolves the current install path from `~/.claude/plugins/installed_plugins.json` at session start, so plugin updates are picked up automatically on the next session.
- **Object form** — set `skipMcpDiscovery: true` when Tomo should own the plugin's MCP connections and ignore its bundled `.mcp.json`.

Unresolvable entries are skipped with a warning in the logs — a bad plugin ref never blocks startup. Note that plugins whose functionality is defined entirely in their *marketplace entry* (rather than in the plugin directory, e.g. some LSP-only plugins) cannot be loaded this way; Tomo logs a warning when a plugin directory contains no recognizable components.

### Scheduled Tasks

Tomo can create scheduled tasks on its own — just ask "remind me in 30 minutes to stretch" or "check the weather every morning at 9am." Supports one-shot reminders, recurring intervals, and cron expressions.

### Pet

Tomo can hatch and raise a virtual pet — Tamagotchi-style, with hunger, mood, energy, and growth stages, persisted in `~/.tomo/data/pet.json`. Tomo cares for it with its pet tools; check in with `/pet`.

### Sessions

- Multi-turn conversations via Claude Agent SDK session resume
- Persistent across restarts
- `/new` in Telegram to start fresh
- Unlinked sessions kept for 30 days before cleanup

### Context Management (LCM)

Instead of lossy auto-compaction, long conversations are rolled up into hierarchical summary blocks (daily → weekly → monthly → yearly), so old context degrades gracefully rather than disappearing. The `lcm` config block controls the housekeeping nudges: at `nudgeAtPct` context usage (default 70%) Tomo is prompted to prune bulky tool results or run a rollup, re-arming once usage drops below `nudgeResetPct`; `groupCompactStyle` chooses hierarchical rollups (`"lcm"`, default) or SDK auto-compact (`"sdk"`) for group chats.

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
    CONTINUITY.md             # Standing instructions for continuity heartbeats
    memory/                   # Persistent memory files
      people/                 # People registry records (private ones under memory/private/people/)
    secrets/                  # Harness-managed credentials (e.g. MCP OAuth tokens, mode 0600)
    .claude/skills/           # Agent skills
  data/
    cron/jobs.json            # Scheduled tasks
    sessions/                 # Transcript logs and session registry
    pet.json                  # Virtual pet state
    summons.json              # Active group summons
  logs/
    tomo.log                  # Daemon logs
```

## Configuration

Run `tomo config` for interactive setup, or edit `~/.tomo/config.json` directly:

```json
{
  "auth": {
    "method": "api-key",
    "apiKey": "sk-ant-..."
  },
  "channels": {
    "telegram": {
      "token": "your-bot-token",
      "allowlist": ["123456789"],
      "passiveGroups": ["-1001234567890"]
    },
    "imessage": { "provider": "imsg", "allowlist": ["+15551234567"] }
  },
  "identities": [
    {
      "name": "yourname",
      "channels": { "telegram": "123456789", "imessage": "+15551234567" },
      "replyPolicy": "last-active"
    }
  ],
  "model": "claude-sonnet-5[1m]",
  "litellm": {
    "mode": "chatgpt-subscription",
    "baseUrl": "http://localhost:4000",
    "apiKey": "sk-tomo-local"
  },
  "maxTurns": 50,
  "saveInboundImages": true,
  "saveInboundFiles": true,
  "continuity": true,
  "continuityIntervalMinutes": 55,
  "continuityScript": {
    "path": "~/bin/tomo-continuity.sh",
    "timeoutMs": 30000,
    "maxOutputChars": 8000
  },
  "groupSecret": "tomo-xxxxxxxx",
  "summonExpiryMinutes": 60,
  "lcm": {
    "nudgeAtPct": 70,
    "nudgeResetPct": 60,
    "groupCompactStyle": "lcm"
  }
}
```

To enable iMessage (the Tomo process needs Full Disk Access; advanced features additionally need `imsg launch`):

```json
{
  "channels": {
    "imessage": { "provider": "imsg", "cliPath": "/opt/homebrew/bin/imsg", "allowlist": ["+15551234567"] }
  }
}
```

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Use Anthropic API-key authentication; overrides the authentication stored in `config.json` |
| `TELEGRAM_BOT_TOKEN` | Override Telegram token |
| `IMESSAGE_PROVIDER` | Set to `imsg` to enable the iMessage channel (unset = iMessage off) |
| `IMSG_CLI_PATH` | Path to the `imsg` binary (default: `imsg` on PATH) |
| `IMSG_DB_PATH` | Override chat.db path passed to `imsg rpc --db` |
| `IMESSAGE_TYPING_START_DELAY_MS` | Delay before showing iMessage typing for ordinary turns (default: `1200`) |
| `IMESSAGE_PASSIVE_TYPING_START_DELAY_MS` | Delay before showing iMessage typing for passive iMessage group turns (default: `4000`) |
| `CLAUDE_MODEL` | Override model |
| `TOMO_LITELLM_BASE_URL` | Route Claude Agent SDK model calls through a LiteLLM proxy |
| `TOMO_LITELLM_API_KEY` | API key sent to the LiteLLM proxy as `ANTHROPIC_API_KEY` |
| `TOMO_LITELLM_MODE` | Optional LiteLLM mode: `anthropic-compatible` or `chatgpt-subscription` |
| `TOMO_WORKSPACE` | Override workspace directory |
| `TOMO_MAX_TURNS` | Override per-turn tool-use ceiling (default: `50`) |
| `TOMO_STEERING` | Override message steering. Defaults to `true`; set `false` to keep mid-turn messages queued. |
| `TOMO_SAVE_INBOUND_FILES` | Override storage of inbound attachments that are neither images nor supported documents. Defaults to whatever `saveInboundImages` is. |
| `TOMO_SHOW_THINKING` | Deliver the model's thinking blocks to the chat, prefixed with `💭`. Defaults to `false`; with it off, a thinking block that still has text in it is delivered unprefixed, as a `text` block would be. |
| `TOMO_CONTINUITY_INTERVAL_MINUTES` | Override scheduled continuity heartbeat interval (default: `55`, minimum: `1`) |
| `TOMO_CONTINUITY_SCRIPT` | Override the optional continuity script path |
| `TOMO_CONTINUITY_SCRIPT_TIMEOUT_MS` | Override continuity script timeout (default: `30000`) |
| `TOMO_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS` | Override continuity script stdout/stderr cap (default: `8000`) |
| `LOG_LEVEL` | Log level (default: `debug`) |

### Per-Agent Permission Scoping (`agentProfiles`)

Every session runs the Claude Agent SDK in `bypassPermissions` mode, and the SDK propagates that mode into subagents — so a subagent tomo dispatches inherits your whole machine. `AgentDefinition` scopes **tools** and has no notion of a **path**, which means `tools: Read, Grep, Glob, Bash` on an agent described as "read-only reviewer" is a full shell.

`agentProfiles` fences that in, keyed by the agent type name (the `.claude/agents/<name>.md` filename). Enforcement is a `PreToolUse` hook, which the SDK consults *before* `canUseTool` and which a `bypassPermissions` session cannot skip.

```json
{
  "agentProfiles": {
    "ios-reviewer": {
      "writeRoots": [
        "~/.tomo/workspace/tmp",
        "/tmp",
        "/private/tmp",
        "$TMPDIR",
        "~/Library/Developer/Xcode/DerivedData",
        "~/Library/Developer/CoreSimulator",
        "~/Library/Caches"
      ],
      "denyPaths": [
        "~/Library/LaunchAgents",
        "/Applications",
        "~/.claude",
        "~/.tomo/workspace/memory",
        "~/.tomo/workspace/.claude",
        "~/Developer/bloom",
        "~/Developer/wayfound"
      ],
      "denyReadPaths": [
        "~/.ssh",
        "~/.tomo/config.json",
        "~/.tomo/workspace/memory/private"
      ],
      "bash": "readonly"
    },
    "ios-implementer": {
      "writeRoots": [
        "~/.tomo/workspace/tmp",
        "/tmp",
        "/private/tmp",
        "$TMPDIR",
        "~/Library/Developer/Xcode/DerivedData",
        "~/Library/Developer/CoreSimulator",
        "~/Library/Caches"
      ],
      "denyPaths": [
        "~/Library/LaunchAgents",
        "/Applications",
        "~/.claude",
        "~/.tomo/workspace/memory",
        "~/.tomo/workspace/.claude"
      ],
      "denyReadPaths": [
        "~/.ssh",
        "~/.tomo/config.json",
        "~/.tomo/workspace/memory/private"
      ],
      "bash": "worktree"
    }
  }
}
```

The two profiles differ in exactly two places, and both differences are the point. The reviewer cannot write the shared checkouts under `~/Developer` — but it can and must **read** them, which is why they sit on `denyPaths` and not `denyReadPaths`. The implementer has to write in one of them, so they are off its list entirely, and its Bash mode is `worktree` rather than `readonly`.

Both list `/tmp` **and** `/private/tmp` because `/tmp` is a symlink to the second on macOS, and both list `$TMPDIR` because `xcodebuild` and `simctl` write there constantly. Both fence `~/.tomo/workspace/memory` and `~/.tomo/workspace/.claude`, which is what makes `rm -rf memory` and `git clean -fdx` refusals rather than restore-from-backup — see "relative paths" below.

| Field | Meaning |
|-------|---------|
| `writeRoots` | Absolute roots the agent may write into. Empty (or omitted) means it may write nowhere — unless `bash` is `full`, which switches `writeRoots` off entirely. |
| `denyPaths` | A **write** fence: paths the agent may not write to, by file tool, write verb, or redirection. **Reads are unaffected.** Beats `writeRoots`, and a destructive verb aimed at an *ancestor* of one is denied too, because `rm -rf <parent>` takes the protected path with it. |
| `denyReadPaths` | The **secrets** list: paths the agent may not *name at all*, by any tool including `Read`/`Grep`/`Glob`. Strictly stronger than `denyPaths`; a path here needs no entry there. |
| `bash` | `none` \| `readonly` \| `worktree` \| `full`. Defaults to `none`. |

**Why two deny lists.** A reviewer's whole job is to read the checkouts it must never modify. One combined list forces you to choose between "the reviewer cannot review bloom" and "the reviewer can `rm -rf` bloom". `denyPaths` fences the write; `denyReadPaths` is kept for the short list of paths where *reading* is itself the harm.

Bash modes:

- **`none`** — the Bash tool is denied outright.
- **`readonly`** — write *verbs* are denied: `rm`, `rmdir`, `mv`, `cp`, `tee`, `dd`, `chmod`, `chown`, `ln`, `mkdir`, `touch`, `truncate`, `install`, `unlink`, `shred`, `ditto`, `chflags`, `brew`, `launchctl`, `wget`, `sed -i`, `perl -i`, `find … -delete`, `rsync … --delete`, `curl -o|-O|--output`, `xattr -w|-d`, `git push|commit|checkout|reset|rebase|stash|clean|merge|apply`, `git worktree remove|prune`, `git config --global|--system`, `gh pr merge|close`, `npm install|publish|ci`, `defaults write`, `simctl delete|erase|shutdown|boot`, `xcodebuild clean`, `swift package reset|clean`. So is a `>`/`>>` redirection onto an *absolute* target outside `writeRoots`. Command substitution, backticks and pipes are **allowed** — see the note below. `kill`/`killall`/`pkill` are **not** denied: a signal is not a filesystem write, and clearing a wedged simulator is routine reviewer work.
- **`worktree`** — the write verbs come back. An *absolute* path token on a write command must land inside `writeRoots`.
- **`full`** — only `denyPaths` and `denyReadPaths` apply, to Bash *and* to `Write`/`Edit`/`MultiEdit`/`NotebookEdit`.

**Relative paths, and what `worktree` mode does not fence.** The daemon is never told where a subagent's worktree is — the Agent tool's `isolation: "worktree"` does not report the path back — so a relative token is a path whose destination is unknowable here. It is therefore **never judged on the allow side**: `mkdir -p Sources/New`, `rm -rf build/Old` and `git commit -m msg` all pass, which is what makes the mode usable at all. On the **deny side** a relative write target *is* resolved, against the workspace directory, because that is the cwd a subagent inherits when it has no worktree of its own — so `rm -rf memory`, `rm -rf *`, `rm -rf .` and `git clean -fdx` are refused when the workspace's own trees are on `denyPaths`. The consequence to be clear about: **a `worktree`-mode agent is fenced from the workspace, not from its own worktree.** It can destroy its own working copy, by design, and no rule here can tell it apart from the work it was sent to do.

Paths are expanded at config load: `~`, `~/x`, `$VAR` and `${VAR}`. What happens to one that does not come out absolute depends on which list it is in, and the asymmetry is deliberate — a dropped `writeRoot` only *narrows* the agent, while a dropped deny entry *widens* it:

- a bad **`writeRoots`** entry is dropped with a `log.warn`. This is also what keeps an unset `$TMPDIR` (absent under a bare `launchctl load`) from bricking the daemon.
- a bad **`denyPaths`/`denyReadPaths`** entry is dropped with a `configIssues` entry, which **refuses daemon startup**.

An agent type with **no profile is unconstrained**. That is the deliberate v1 default: the real tool surface of `general-purpose`, `Explore` and ad-hoc delegations is not known yet, and failing closed would break all of them on the first turn. Instead the daemon logs one `warn` per session per unprofiled agent type, and logs *every* subagent Bash call at `info` with the agent type and the first 120 characters of the command. Read those logs before tightening the default.

> **This is policy, not a sandbox.** The checks run inside the tomo daemon; the thing they constrain is a CLI child process, which is the wrong side of a trust boundary for real isolation. `readonly` deliberately permits `$(…)`, backticks and pipes, because a reviewer's normal working command is `git log $(git merge-base main HEAD)` and refusing substitution refuses the reviewer. The verb list above is a *list*: it is long, it is still incomplete, and every entry is a command someone noticed. An agent that wants out gets out. What this closes is the *accident* — an agent that was told to review a PR deciding to delete a shared checkout, or to write into `/Applications` — which is the failure mode that actually happens.

### Anthropic Authentication

Direct Claude models use your existing Claude Code subscription login by default. To use Anthropic API billing instead, run `tomo config`, choose **Anthropic authentication**, and enter an API key. Tomo stores the selected method under `auth` in `~/.tomo/config.json` and passes the key only to direct Claude Agent SDK child processes. `ANTHROPIC_API_KEY` remains supported and takes precedence over the saved setting.

Because the config contains channel credentials and may now contain an Anthropic API key, Tomo writes both `config.json` and `config.json.bak` with owner-only (`0600`) permissions.

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
