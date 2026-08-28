# Config file reference (`~/.tomo/config.json`)

Prefer editing via `tomo config` (interactive TUI). This reference is for reading/verifying values or scripted edits. **Manual edits require `tomo restart` to take effect.** Chat `/model <name>` writes `sessionModelOverrides` and applies to that session without a restart.

Before direct edits, copy `~/.tomo/config.json` to `~/.tomo/config.json.bak`. Chat `/restore` restores that backup over `config.json` and restarts Tomo.

## Full example (every supported field)

```json
{
  "model": "claude-sonnet-5[1m]",
  "city": "Seattle",
  "continuity": false,
  "continuityIntervalMinutes": 55,
  "continuityScript": {
    "path": "~/bin/tomo-continuity.sh",
    "timeoutMs": 30000,
    "maxOutputChars": 8000
  },
  "groupSecret": "tomo-a1b2c3d4",
  "channels": {
    "telegram": {
      "token": "123456:ABC-DEF1234ghIkl-zyx57W2v...",
      "allowlist": ["123456789"],
      "passiveGroups": ["-1001234567"]
    },
    "imessage": {
      "provider": "imsg",
      "allowlist": ["+15551234567", "iMessage;-;+15551234567"]
    }
  },
  "identities": [
    {
      "name": "alice",
      "channels": {
        "telegram": "123456789",
        "imessage": "+15551234567"
      },
      "replyPolicy": "last-active"
    }
  ],
  "sessionModelOverrides": {
    "dm:alice": "claude-opus-4-8[1m]"
  },
  "litellm": {
    "mode": "chatgpt-subscription",
    "baseUrl": "http://localhost:4000",
    "apiKey": "sk-tomo-local"
  },
  "maxTurns": 50,
  "mcpServers": {
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
  },
  "plugins": [
    "~/my-plugins/deploy-tools",
    "code-reviewer@claude-plugins-official",
    { "path": "./relative/plugin", "skipMcpDiscovery": true }
  ],
  "lcm": {
    "nudgeAtPct": 70,
    "nudgeResetPct": 60,
    "groupCompactStyle": "sdk",
    "dailyFreshTail": 32
  }
}
```

## Field reference

| Field | Type | Allowed values / notes |
|---|---|---|
| `model` | string | Claude model IDs/aliases, or a LiteLLM `provider/model` name such as `chatgpt/gpt-5.5`. Default model for every session. |
| `city` | string \| null | Any city name (e.g. `"Seattle"`). Used for weather in continuity pings. `null` or missing = no weather. |
| `continuity` | boolean | `true` / `false`. Enables periodic proactive heartbeats. Off by default. |
| `continuityIntervalMinutes` | number | Optional. Minutes between scheduled continuity heartbeats. Default `55`; minimum `1`. Ignored for manual `tomo continuity` triggers. |
| `continuityScript` | string \| object \| null | Optional script run once per scheduled continuity heartbeat and manual `tomo continuity` trigger before the prompt is sent to Tomo. Use a string path (`"~/bin/tomo-continuity.sh"`) or `{ "path": "...", "timeoutMs": 30000, "maxOutputChars": 8000 }`. Relative paths resolve under `~/.tomo`; `~`, `$VAR`, and `${VAR}` expand. The script runs as the Tomo OS user with `TOMO_CONTINUITY=true`; stdout/stderr are appended to the heartbeat prompt and capped separately by `maxOutputChars`. Non-zero exits, missing files, and timeouts are passed to Tomo as script status instead of aborting the heartbeat. |
| `groupSecret` | string \| null | Passphrase users send in a group chat to activate Tomo there. `null` disables group chats entirely. |
| `channels.telegram.token` | string | BotFather token (`123456:...`). Required to enable the Telegram channel. |
| `channels.telegram.allowlist` | string[] | Telegram user IDs (as strings) permitted to DM the bot. Identity-bound chatIds are auto-allowed even if missing here. |
| `channels.telegram.passiveGroups` | string[] | Telegram group chatIds (negative IDs as strings) where Tomo should listen to every message — no `@mention` required. Tomo decides via `NO_REPLY` whether to respond. iMessage groups are always passive regardless of this list. |
| `channels.imessage.provider` | string | `"imsg"` — the only backend, and required to enable the iMessage channel. Omit the key to leave iMessage off. Tomo needs Full Disk Access; advanced features (tapbacks, typing, unsend, rename, threaded replies) also need `imsg launch`. |
| `channels.imessage.cliPath` | string | Optional path to the `imsg` binary. Default: `imsg` resolved from `PATH`. |
| `channels.imessage.dbPath` | string | Optional chat.db path forwarded to `imsg rpc --db`. |
| `channels.imessage.allowlist` | string[] | Phone numbers (`+15551234567`) or iMessage chat GUIDs (`iMessage;-;+15551234567`, `iMessage;+;chat...`). |
| `identities[].name` | string | Unified identity name (lowercased to form the session key `dm:<name>`). |
| `identities[].channels` | object | `{ channelName: chatId }` — maps each channel the identity uses to its chatId. |
| `identities[].replyPolicy` | string | `"last-active"` (reply on whichever channel the identity last messaged from) or a fixed channel name like `"telegram"` / `"imessage"` (always reply there). |
| `sessionModelOverrides` | object | `{ sessionKey: modelId }` — per-session model override, takes precedence over top-level `model`. Keys are session keys (`dm:alice`, `telegram:12345`, etc.). Written by `/model <name>` for the current chat and by the `tomo config` Sessions menu. |
| `litellm.mode` | string | Optional mode label. `"anthropic-compatible"` (default) is a generic proxy; `"chatgpt-subscription"` is the tested OpenAI/ChatGPT subscription path through LiteLLM. Also settable with `TOMO_LITELLM_MODE`. |
| `litellm.baseUrl` | string | Optional LiteLLM proxy base URL, e.g. `http://localhost:4000`. When set, Tomo still uses Claude Agent SDK but sends SDK model calls to the proxy via `ANTHROPIC_BASE_URL`. |
| `litellm.apiKey` | string | LiteLLM proxy key sent as `ANTHROPIC_API_KEY`. This is the proxy key, not an Anthropic key. For ChatGPT subscription models, LiteLLM owns the OAuth device flow and token storage. |
| `maxTurns` | number | Max agent turns per single user message (one turn ≈ one tool-use round). Default `50`. Raise if you see "max turns exceeded" on long tool chains. |
| `steering` | boolean | Optional. Default `true`. User messages that arrive while a turn is in flight bypass the per-session queue and are injected at the next tool-call boundary. If the current turn has no boundary left, the message runs as a follow-up turn. Cron, continuity, and other system-originated turns still queue normally. Set `false` or `TOMO_STEERING=false` to keep mid-turn messages queued behind the active turn. |
| `mcpServers` | object | External MCP servers keyed by server name. Supports stdio (`command`, `args`, `env`), HTTP (`type: "http"`, `url`, `headers`), and SSE (`type: "sse"`, `url`, `headers`). Environment variables like `${HOME}` expand in `url`, `headers`, `env`, and `args`. |
| `mcpServers.<name>.oauth` | object | Optional harness-managed OAuth for HTTP/SSE MCP servers. Supports `authorizationServer` (optional; omitted = discover from the MCP server), `clientId` (optional if dynamic registration is available), `scopes`, `tokenStoreKey`, `redirectUri`, and `clientName`. Tokens are stored outside agent context in `workspace/secrets/mcp-oauth.json` (`0600`). |
| `plugins` | array | Claude Code plugins loaded into every session. Entries: local plugin-root paths (`~/x`, `./x` — relative resolves against `~/.tomo`), CLI-installed refs (`name` or `name@marketplace` from `claude plugin install`, resolved via `~/.claude/plugins/installed_plugins.json` at session spawn), or `{ "path"\|"name", "skipMcpDiscovery" }` objects. Shape errors refuse startup like any config field; resolution failures (uninstalled, deleted, ambiguous) log a warning and skip the entry. |
| `mcpAllowedTools` | string[] | Auto-allowed external MCP tools. If omitted, Tomo defaults to `mcp__<server>__*` for every configured external server. Set this to narrow tool access, e.g. `["mcp__github__list_issues"]`. |
| `lcm.nudgeAtPct` | number | Context-usage % at which the harness nudges the agent to run `tomo lcm daily`. Default `70`. Lower = compact earlier and more often. |
| `lcm.nudgeResetPct` | number | Hysteresis reset threshold — the "already nudged" flag clears once usage drops below this %. Default `60`. Must be less than `nudgeAtPct`; invalid values fall back to defaults. |
| `lcm.groupCompactStyle` | string | `"sdk"` (default) or `"lcm"`. `"sdk"` lets the SDK auto-compact group sessions; `"lcm"` opts groups into the same hierarchical LCM flow as DMs (disables SDK auto-compact and fires all three harness nudges: 70% daily, 80% safety net, and the periodic rollup runner). DMs always use LCM regardless. |
| `lcm.dailyFreshTail` | number | Number of most-recent raw user/assistant events kept outside today's daily rollup so mid-day compacts don't wipe warm short-term texture. Default `32`. Counts SDK events (one tool round = multiple events), not user-typed messages. Set to `0` to compact every event into today's block. Past days are always compacted in full regardless of this value. |

## ChatGPT subscription via LiteLLM

For `litellm.mode: "chatgpt-subscription"`, the matching LiteLLM proxy config should include:

```yaml
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

Start it with `litellm --config ~/litellm-chatgpt.yaml`, then set Tomo's model to `chatgpt/gpt-5.5`. If LiteLLM rejects system messages, use a build with ChatGPT system-role normalization. Tomo uses streaming Anthropic `/v1/messages`, so non-streaming LiteLLM test requests can still fail while Tomo works.

## Requirements and overrides

- **At least one channel must be configured** — either `channels.telegram.token` or `channels.imessage.provider: "imsg"`. Startup fails otherwise.
- **Env vars override file values** where they exist: `TELEGRAM_BOT_TOKEN`, `IMESSAGE_PROVIDER`, `IMSG_CLI_PATH`, `IMSG_DB_PATH`, `CLAUDE_MODEL`, `TOMO_LITELLM_BASE_URL`, `TOMO_LITELLM_API_KEY`, `TOMO_LITELLM_MODE`, `TOMO_CITY`, `TOMO_CONTINUITY`, `TOMO_CONTINUITY_INTERVAL_MINUTES`, `TOMO_WORKSPACE`, `SESSIONS_DIR`, `HISTORY_LIMIT`, `TOMO_MAX_TURNS`, `TOMO_STEERING`.
- `workspaceDir`, `sessionsDir`, `historyLimit` are env-only — they're not read from the JSON file.
