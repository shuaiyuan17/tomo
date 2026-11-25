# Configuration

Run `tomo config` for interactive setup, or edit `~/.tomo/config.json` directly. Config is validated at startup: an invalid entry refuses daemon start with a message naming it (`tomo config` still runs, so you can repair it). Tomo writes `config.json` and `config.json.bak` with owner-only (`0600`) permissions; `/restore` in chat rolls back to the backup.

- [Example `config.json`](#example-configjson)
- [Authentication](#authentication)
- [iMessage](#imessage)
- [Environment variables](#environment-variables)
- [External MCP servers](#external-mcp-servers)
- [Claude Code plugins](#claude-code-plugins)
- [Continuity heartbeats](#continuity-heartbeats)
- [Steering](#steering)
- [Durable inbox](#durable-inbox)
- [Interrupted subagents](#interrupted-subagents)
- [Context management (LCM)](#context-management-lcm)
- [Logging and observability](#logging-and-observability)
- [LiteLLM / ChatGPT subscription models](#litellm--chatgpt-subscription-models)
- [Files on disk](#files-on-disk)

Security-related settings (`groupSandbox`, `credentialBroker`, `agentProfiles`) are in [Permissions and privacy](permissions-and-privacy.md); web UI settings in [web-ui.md](web-ui.md); todo limits in [todos.md](todos.md#limits).

## Example `config.json`

```json
{
  "auth": {
    "method": "api-key",
    "apiKey": "sk-ant-..."
  },
  "owner": {
    "name": "yourname",
    "displayName": "Your Name",
    "telegram": ["123456789"],
    "imessage": ["+15551234567"]
  },
  "channels": {
    "telegram": {
      "token": "your-bot-token",
      "allowlist": ["-1001234567890"],
      "passiveGroups": ["-1001234567890"]
    },
    "imessage": { "provider": "imsg", "allowlist": ["any;+;<group-chat-guid>"] }
  },
  "model": "claude-opus-5-5[1m]",
  "litellm": {
    "mode": "chatgpt-subscription",
    "baseUrl": "http://localhost:4000",
    "apiKey": "sk-tomo-local"
  },
  "maxTurns": 50,
  "agent": { "name": "Claw" },
  "locale": "zh-Hans",
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
  "notifyOwnerOnSuppressedErrors": true,
  "lcm": {
    "nudgeAtPct": 70,
    "nudgeResetPct": 60,
    "blockSpawnAtPct": 80,
    "groupCompactStyle": "lcm"
  },
  "todos": { "maxOpen": 30, "maxSnoozes": 3 },
  "web": { "enabled": true, "port": 9465 }
}
```

## Authentication

Direct Claude models use your Claude subscription login by default. Tomo runs the Claude Code binary bundled with its Agent SDK dependency, so a separate `claude` install is not required: `tomo init` offers to log in through it, and `/login` from your owner DM refreshes it later.

To use Anthropic API billing instead, run `tomo config`, choose **Anthropic authentication**, and enter an API key. Tomo stores the selected method under `auth` and passes the key only to direct Claude Agent SDK child processes. `ANTHROPIC_API_KEY` remains supported and takes precedence over the saved setting.

## iMessage

Pick iMessage in `tomo init` or `tomo config` → Channels, or edit the config. The Tomo process needs Full Disk Access; advanced features additionally need `imsg launch`.

```json
{
  "channels": {
    "imessage": { "provider": "imsg", "cliPath": "/opt/homebrew/bin/imsg" }
  },
  "owner": { "name": "yourname", "imessage": ["+15551234567"] }
}
```

Only the bound handle's DMs are answered; iMessage groups need the group secret (or an explicit `allowlist` entry with the group's chat GUID).

## Environment variables

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Use Anthropic API-key authentication; overrides the authentication stored in `config.json` |
| `CLAUDE_MODEL` | Override model |
| `TELEGRAM_BOT_TOKEN` | Override Telegram token |
| `IMESSAGE_PROVIDER` | Set to `imsg` to enable the iMessage channel (unset = iMessage off) |
| `IMSG_CLI_PATH` | Path to the `imsg` binary (default: `imsg` on PATH) |
| `IMSG_DB_PATH` | Override chat.db path passed to `imsg rpc --db` |
| `IMESSAGE_INBOUND_SETTLE_MS` | How long to wait for more fragments of a split iMessage before answering (default: `1500`) |
| `IMESSAGE_INBOUND_MAX_SETTLE_MS` | Upper bound on that wait (default: `5000`) |
| `IMESSAGE_TYPING_START_DELAY_MS` | Delay before showing iMessage typing for ordinary turns (default: `1200`) |
| `IMESSAGE_PASSIVE_TYPING_START_DELAY_MS` | Delay before showing iMessage typing for passive iMessage group turns (default: `4000`) |
| `TOMO_LITELLM_BASE_URL` | Route Claude Agent SDK model calls through a LiteLLM proxy |
| `TOMO_LITELLM_API_KEY` | API key sent to the LiteLLM proxy as `ANTHROPIC_API_KEY` |
| `TOMO_LITELLM_MODE` | Optional LiteLLM mode: `anthropic-compatible` or `chatgpt-subscription` |
| `TOMO_WORKSPACE` | Override workspace directory |
| `TOMO_MAX_TURNS` | Override per-turn tool-use ceiling (default: `50`; `0` = no limit, which also turns off the 75%/90% wrap-up reminders) |
| `TOMO_STEERING` | Message steering (default `true`; `false` keeps mid-turn messages queued). See [Steering](#steering) |
| `TOMO_INBOX` | Durable inbox (default `true`; `false` holds waiting messages in memory only). See [Durable inbox](#durable-inbox) |
| `TOMO_INBOX_REPLAY_MAX_AGE_MINUTES` | Oldest waiting message answered after a restart (default: `360`; `0` = never replay, only record) |
| `TOMO_INTERRUPTED_AGENTS` | Track running subagents on disk and report the ones a restart or crash cut off (default `true`) |
| `TOMO_INTERRUPTED_AGENTS_AUTO_RESUME` | After a restart, tell each session to resume its resumable subagents right away (config key `interruptedAgents.autoResume`, default `true`) |
| `TOMO_SUMMON_EXPIRY_MINUTES` | Group inactivity after which a `/summon` expires (config key `summonExpiryMinutes`, default: `60`) |
| `TOMO_SAVE_INBOUND_FILES` | Override storage of inbound attachments that are neither images nor supported documents. Defaults to whatever `saveInboundImages` is |
| `TOMO_NOTIFY_OWNER_ON_SUPPRESSED_ERRORS` | Tell the owner when a failure is kept out of a chat (config key `notifyOwnerOnSuppressedErrors`, default `true`). See below |
| `TOMO_SHOW_THINKING` | Deliver the model's thinking blocks to the chat, prefixed with `💭` (config key `showThinking`, default `false`). See below |
| `TOMO_CONTINUITY` | Enable continuity heartbeats (config key `continuity`, default `false`) |
| `TOMO_CONTINUITY_INTERVAL_MINUTES` | Heartbeat interval (default: `55`, minimum: `1`) |
| `TOMO_CONTINUITY_SCRIPT` | Optional continuity script path |
| `TOMO_CONTINUITY_SCRIPT_TIMEOUT_MS` | Continuity script timeout (default: `30000`) |
| `TOMO_CONTINUITY_SCRIPT_MAX_OUTPUT_CHARS` | Continuity script stdout/stderr cap (default: `8000`) |
| `TOMO_LOCALE` | Language for Tomo's own fixed text (config key `locale`; `"en"` or `"zh-Hans"`; default: unset). Chat-command replies and Tomo's notices to the owner (permission and credential requests, error, MCP, cron, pet and update notices) are written in it, and it sets the web UI's default language (a browser's own pick in the Study's Config tab wins; unset, the browser's language decides). Model-facing text, logs and the CLI stay English |
| `TOMO_CITY` | City for weather in continuity heartbeats and the web UI's Home sky, from wttr.in (config key `city`, default: unset) |
| `TOMO_LIVE_SESSION_TIMEOUT_MS` | Inactivity timeout for one turn (config key `liveSessionTimeoutMs`, default: `600000`, 10 minutes) |
| `TOMO_LIVE_SESSION_IDLE_TIMEOUT_MS` | Close a live session (its Claude Code child and MCP servers) after this long with nothing running; the next message resumes it from disk (config key `liveSessionIdleTimeoutMs`, default: `3600000`, 60 minutes; `0` keeps idle sessions forever) |
| `TOMO_METRICS` | Enable the metrics exporter and activity log (config key `metrics.enabled`, default: `false`) |
| `TOMO_METRICS_PORT` | Metrics port (config key `metrics.port`, default: `9464`) |
| `LOG_LEVEL` | Log level (default: `debug`) |

**`notifyOwnerOnSuppressedErrors`** covers passive-group turns, group cron/background turns, and silent housekeeping/heartbeat turns on the owner's own DM (an error already shown in a chat is not repeated). Group failures are reported in the owner's DM, never in the group; DM failures in that DM. Each notice names the session, the kind of error, a one-line excerpt and a recovery hint (`/login` for auth failures). At most one notice per session and error kind per 30 minutes; the next one says how many failures were folded in. Set `false` to keep these failures in the log only.

**`showThinking`**: with it off, thinking blocks are dropped (not delivered, not recorded in the transcript), and if the model put its reply in one it is asked to restate it as text — after its next tool call, or in one follow-up turn if the turn ended there (see `showThinking` in `defaults/skills/system/CONFIG.md`). Read at session start.

## External MCP servers

Add remote or local MCP servers under `mcpServers`. Tomo passes them through to the Claude Agent SDK and, by default, auto-allows all tools from each configured server with `mcp__<server>__*`.

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

**OAuth.** Remote HTTP/SSE servers can use harness-managed OAuth by adding an `oauth` block. Tomo discovers the authorization server from the MCP server's RFC 9728 `WWW-Authenticate` challenge unless `authorizationServer` is set explicitly, uses authorization-code + PKCE, registers a dynamic client when needed, stores tokens in `~/.tomo/workspace/secrets/mcp-oauth.json` with mode `0600`, silently refreshes near-expiry tokens, and injects `Authorization: Bearer <token>` into MCP headers. The agent never sees the tokens.

If browser login is needed, Tomo forwards the authorize URL to your private chat without blocking the agent session. When the browser is on another device and its localhost redirect cannot reach the Tomo host, paste the full redirect URL back into the owner's private DM; Tomo matches its single-use `state`, exchanges the code with the server-side PKCE verifier, and stores the resulting token. Once authentication succeeds, Tomo hot-mounts the server into live sessions without waiting for a restart; older SDKs and rejected runtime updates fall back to mounting it in the next session. `/mcp` shows configured servers, per-session mount state, token expiry, pending authorization, and the latest auth failure; `/mcp login <server>` starts or reuses one background flow for that server.

## Claude Code plugins

Tomo can load [Claude Code plugins](https://code.claude.com/docs/en/agent-sdk/plugins) — bundles of skills, agents, slash commands, hooks, and MCP servers — into every session. Add a top-level `plugins` array:

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
- **Installed plugin refs** — plugins you already installed with `claude plugin marketplace add ...` + `claude plugin install ...`. Use the full `name@marketplace` id, or the bare name when it's unambiguous. Tomo resolves the current install path from `~/.claude/plugins/installed_plugins.json` at session start, so plugin updates are picked up on the next session.
- **Object form** — set `skipMcpDiscovery: true` when Tomo should own the plugin's MCP connections and ignore its bundled `.mcp.json`.

Unresolvable entries are skipped with a warning in the logs — a bad plugin ref never blocks startup. Plugins whose functionality is defined entirely in their *marketplace entry* (rather than in the plugin directory, e.g. some LSP-only plugins) cannot be loaded this way; Tomo logs a warning when a plugin directory contains no recognizable components.

> [!NOTE]
> A plugin that carries a `PreToolUse` hook disables Bash on group turns. See [Permissions and privacy](permissions-and-privacy.md#private-memory-and-group-turns).

## Continuity heartbeats

With `continuity` on, Tomo gets a periodic heartbeat (every `continuityIntervalMinutes`, default 55) — unstructured time to reflect, tidy memory, journal, or prepare something for the next conversation. Standing instructions for heartbeats live in `~/.tomo/workspace/CONTINUITY.md`; `tomo continuity` triggers one by hand.

`continuityScript` can be an object (above) or a simple path string, e.g. `"continuityScript": "~/bin/tomo-continuity.sh"`. Relative paths resolve under `~/.tomo`; the script runs once per heartbeat (scheduled or manual), and its stdout/stderr or failure status is appended to the heartbeat prompt. `tomo todo due` is a good thing to call from it.

## Steering

By default, messages you send while Tomo is mid-task are steered into the in-flight turn at the next tool-call boundary — so "stop", "wait", or extra context reaches the model immediately instead of waiting for the current turn to finish. If the turn has no tool calls left, the message runs as its own follow-up turn right after. iMessage fragment settling still applies before injection; system-originated turns (cron, continuity) keep their normal queued behavior. Set `"steering": false` or `TOMO_STEERING=false` to keep mid-turn messages queued behind the active turn.

## Durable inbox

Every message Tomo accepts is written to `~/.tomo/data/inbox.jsonl` (fsynced) before the channel is told it was received, and stays there until a turn has consumed it. If the daemon crashes, is killed or restarts while messages are waiting behind a turn, the next start answers them, with a note to the model that they are late. Messages that pile up still coalesce into one turn, as they would have live.

- A redelivered message (same channel, chat and message id) is answered once.
- A turn that was already running when the daemon died is not re-run, because it may have called tools or sent part of a reply already. The session is told to check instead.
- A message older than `inboxReplayMaxAgeMinutes` (default `360`) is recorded in the transcript as not processed rather than answered late.
- Web UI requests, the group secret and attachment bytes are never written there; attachments are reloaded from their saved copies (`saveInboundImages` / `saveInboundFiles`), and one that was never saved is dropped with a note.

Set `"inbox": false` or `TOMO_INBOX=false` to turn it off. Waiting messages are then held in memory, and a graceful shutdown records them as not processed.

## Interrupted subagents

Each session's running subagents and background commands are mirrored to `~/.tomo/data/running-agents.json` (atomic write on every start and end), so a crash is covered as well as a restart. On the next start, every session that had some still running gets one `interrupted-agents` event listing their ids, descriptions, types and last activity. With `interruptedAgents.autoResume` on (the default), the event tells the model to resume each resumable subagent right away with `SendMessage` to its id, unless the owner has said not to, and to have it first check how far it got and which side effects already happened. Explore/Plan subagents and background commands cannot be resumed. The limit is enforced by a hook on `SendMessage`, whichever turn sends it: each resume of an interrupted subagent is counted in the same file before it is allowed (if the count cannot be written, the resume is refused), and after 3 the hook refuses further resumes. A subagent cut off again after 3 resumes is reported to the owner as failed. The count is cleared when the subagent ends on its own.

With `autoResume` off, nothing is resumed automatically: the model is told and decides, and can continue a subagent with `SendMessage` to its id.

```json
{ "interruptedAgents": { "enabled": true, "autoResume": false } }
```

Set `"interruptedAgents": false` (or `{ "enabled": false }`) or `TOMO_INTERRUPTED_AGENTS=false` to turn it all off; the file is then removed, so turning it back on starts clean.

## Sub-sessions

On by default (`"subsessions": { "enabled": false }` turns them off). The owner's own conversation gets `task_spawn`, `task_status`, `task_cancel`, `task_message` and `task_done`: Tomo can hand a long task (a PR to write and see through review, a long investigation) to a separate session that works in the background, survives restarts, and reports back. Each runs under the key `task:<id>` (`s1`, `s2`, …); its messages reach you with a `[s1 · title]` prefix, and its report comes back to the main conversation, which tells you the result and decides what to remember. Sub-sessions don't write memory.

```json
{ "subsessions": { "enabled": true, "maxRunning": 2, "maxOpen": 5, "maxTurns": 200, "maxContextTokens": 500000, "defaultModel": null,
  "mirror": "turn", "maxActiveHours": 24 } }
```

- `maxRunning`: tasks working on their own at once; more wait queued. A message to a task is never queued.
- `maxOpen`: tasks not yet finished, cancelled or failed; `task_spawn` refuses beyond it.
- `maxTurns`: the SDK's turn cap per task turn (`0`: none).
- `maxContextTokens`: between turns, a task over this is compacted with `/compact`.
- `defaultModel`: model for a task that names none (unset follows `model`). Haiku is refused.
- `mirror`: how the main conversation follows what you and a task say to each other. `"turn"` (default): after you write to a task directly, the main conversation takes a short silent turn to read the exchange, so it can act on it (for example tell another task); what a task says on its own (you already read it) waits for the main conversation's next turn, and there is no silent turn while 80% or more of the 5-hour usage window is used. `"note"`: it reads the exchange only on its next turn. Either way it is shown each exchange once and sends nothing by itself. A silent turn costs a little (it reuses the conversation's prompt cache); switch to `"note"` if that adds up.
- `maxActiveHours`: a task that has been working on its own this many hours (active time, counted since your last message to it) pauses and tells you; your next message to it gives it another stretch. `0`: no cap.

A task is its own card: the web UI's Tasks rail and `/s` show where it stands, and nothing is added to your todo list. A task whose report needs you to do something (review and merge a PR, make a choice) says so when it finishes: it shows as **Needs you**, with what it asks, and is not archived until you have done it. Tell Tomo it is done (`task_done`), or send `/s s3 done` from your DM. A report that needs nothing from you just finishes. (An older config's `subsessions.todos` is ignored.)

A task runs unattended, so it gets fewer tools than the main conversation: no external MCP servers (neither `mcpServers` nor any a plugin or a settings file brings) and no claude.ai connectors (Gmail, Calendar, Drive…), only Tomo's own tools plus the built-in ones. Its own turns also pause (and you are told once) while 80% or more of the 5-hour usage window is used, as last recorded in `~/.tomo/data/usage/limits.ndjson`; if that can't be read, they run. A message from you to the task always goes through.

You can also talk to a task yourself, from your own DM (Telegram or iMessage):

- `/s` lists your tasks; `/s s3` shows one.
- `/s s3 <message>` sends it a message (it wakes a task that is waiting for you). Replying to one of its `[s3 · …]` messages does the same.
- `/s s3 stop` cancels it, `/s s3 start` starts a queued one now even past `maxRunning`, `/s s3 model <opus|sonnet|fable>` changes its model from its next turn, `/s s3 done` says you have done what its report asked of you.

Only an exact `stop`, `start`, `done` or `model <name>` is a command; `/s s3 stop the deploy` is a message.

State lives in `~/.tomo/data/subsessions.json` (fsynced, with a `.bak`). If it cannot be read at start, sub-sessions stay off until it is repaired and nothing is unlinked or cancelled.

## Context management (LCM)

Instead of lossy auto-compaction, long conversations are rolled up into hierarchical summary blocks (daily → weekly → monthly → yearly), so old context degrades gracefully rather than disappearing. Anything compacted out stays searchable with the `recall_conversation` tool.

The `lcm` block controls the housekeeping nudges: at `nudgeAtPct` context usage (default 70%) Tomo is prompted to prune bulky tool results or run a rollup, re-arming once usage drops below `nudgeResetPct`; at `blockSpawnAtPct` (default 80, never below `nudgeAtPct`; `0` or `100` turns it off) a session may not start a new background subagent until it is compacted — a compact waits for running background tasks, so a stream of new ones would hold it off indefinitely. Running agents, `SendMessage` to them and foreground subagents are unaffected, and the block lifts as soon as usage is back under the threshold; `groupCompactStyle` chooses hierarchical rollups (`"lcm"`, default) or SDK auto-compact (`"sdk"`) for group chats. `tomo lcm` has the manual tools ([commands.md](commands.md#cli)).

## Logging and observability

- Structured logs via [pino](https://github.com/pinojs/pino) in `~/.tomo/logs/tomo.log` (`tomo logs`, `tomo logs -f`): tool call summaries, token usage and cost per message, context window tracking.
- `tomo watch` opens a live terminal view of the running daemon (activity feed, vitals sidebar, chat line, log tail) over `~/.tomo/watch.sock`.
- `"metrics": { "enabled": true }` serves Prometheus metrics on `http://127.0.0.1:9464/metrics` (`metrics.port` to change it) and writes an NDJSON activity log to `~/.tomo/logs/activity.ndjson` (`metrics.activityLog`, default `true`; `metrics.includeMessageText`, default `true` — turn it off if the log leaves this machine). A ready-made Grafana / Prometheus / Loki stack is in [`contrib/observability/`](../contrib/observability/README.md).
- Cost and usage: `/cost` and `/usage` in chat; per-turn history is kept in `~/.tomo/data/usage/` and shown in the web UI's Study.

## LiteLLM / ChatGPT subscription models

Tomo still runs through the Claude Agent SDK, but you can point the SDK at a local LiteLLM proxy and select a LiteLLM model name such as `chatgpt/gpt-5.5`. This keeps Tomo's sessions, memory, workspace, MCP tools, and LCM behavior while LiteLLM translates Anthropic `/v1/messages` streaming calls to the ChatGPT subscription backend.

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
```

```bash
tomo config   # LiteLLM gateway -> ChatGPT subscription
```

Then set the default model to `chatgpt/gpt-5.5` from `tomo config`, or use `/model chatgpt/gpt-5.5` in a chat. LiteLLM owns the ChatGPT OAuth device flow and token storage; Tomo only sends Anthropic-compatible requests to the local proxy.

If LiteLLM returns `System messages are not allowed`, use a LiteLLM build that includes ChatGPT system-role normalization. If non-streaming curl checks fail while streaming `/v1/messages` works, that is still compatible with Tomo because the Claude Agent SDK uses streaming.

## Files on disk

```
~/.tomo/
  config.json                 # Owner, channels, model, settings (0600)
  tomo.pid                    # PID file (when running)
  web-token, web-access.log   # Web UI token and private access link
  workspace/
    SOUL.md                   # Personality and values
    AGENT.md                  # Operating rules
    IDENTITY.md               # Name and quirks
    CONTINUITY.md             # Standing instructions for continuity heartbeats
    memory/                   # Persistent memory (MEMORY.md index + topic files)
      people/                 # People registry (private records under memory/private/people/)
      private/                # DM-only memory, never visible to groups
    home/                     # Tomo's 3D home scene (drawn by the web UI)
    secrets/                  # Harness-managed credentials (e.g. MCP OAuth tokens, mode 0600)
    .claude/skills/           # Agent skills
  data/
    cron/jobs.json            # Scheduled tasks
    todos/                    # Todo store (todos.json + done.ndjson)
    sessions/                 # Transcript logs and session registry
    inbox.jsonl               # Durable inbox
    running-agents.json       # Subagents running right now (for crash recovery)
    subsessions.json          # Sub-session task table (+ .bak)
    permissions/              # Group permission request log
    pet.json                  # Virtual pet state
    summons.json              # Active group summons
    usage/YYYY-MM.ndjson      # Usage ledger: estimated cost and tokens per turn, per model
    usage/backfill.ndjson     # History from before the ledger started (`tomo usage backfill`)
  logs/
    tomo.log                  # Daemon logs
    activity.ndjson           # Activity log (with metrics enabled)
```

Back it all up with `tomo backup`.
