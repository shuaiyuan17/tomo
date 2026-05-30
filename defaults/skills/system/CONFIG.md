# Config file reference (`~/.tomo/config.json`)

Prefer editing via `tomo config` (interactive TUI). This reference is for reading/verifying values or scripted edits. **Manual edits require `tomo restart` to take effect.** Chat `/model <name>` writes `sessionModelOverrides` and applies to that session without a restart.

Before direct edits, copy `~/.tomo/config.json` to `~/.tomo/config.json.bak`. Chat `/restore` restores that backup over `config.json` and restarts Tomo.

## Full example (every supported field)

```json
{
  "model": "claude-sonnet-4-6",
  "city": "Seattle",
  "continuity": false,
  "groupSecret": "tomo-a1b2c3d4",
  "channels": {
    "telegram": {
      "token": "123456:ABC-DEF1234ghIkl-zyx57W2v...",
      "allowlist": ["123456789"],
      "passiveGroups": ["-1001234567"]
    },
    "imessage": {
      "url": "https://your-bluebubbles.example.com",
      "password": "bluebubbles-password",
      "webhookPort": 3100,
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
    "dm:alice": "claude-opus-4-8"
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
| `model` | string | `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5`. Default model for every session. |
| `city` | string \| null | Any city name (e.g. `"Seattle"`). Used for weather in continuity pings. `null` or missing = no weather. |
| `continuity` | boolean | `true` / `false`. Enables periodic proactive heartbeats. Off by default. |
| `groupSecret` | string \| null | Passphrase users send in a group chat to activate Tomo there. `null` disables group chats entirely. |
| `channels.telegram.token` | string | BotFather token (`123456:...`). Required to enable the Telegram channel. |
| `channels.telegram.allowlist` | string[] | Telegram user IDs (as strings) permitted to DM the bot. Identity-bound chatIds are auto-allowed even if missing here. |
| `channels.telegram.passiveGroups` | string[] | Telegram group chatIds (negative IDs as strings) where Tomo should listen to every message — no `@mention` required. Tomo decides via `NO_REPLY` whether to respond. iMessage groups are always passive regardless of this list. |
| `channels.imessage.url` | string | BlueBubbles server URL. Required to enable the iMessage channel. |
| `channels.imessage.password` | string | BlueBubbles server password. |
| `channels.imessage.webhookPort` | number | Port Tomo listens on for BlueBubbles webhooks. Default `3100`. |
| `channels.imessage.allowlist` | string[] | Phone numbers (`+15551234567`) or iMessage chat GUIDs (`iMessage;-;+15551234567`, `iMessage;+;chat...`). |
| `identities[].name` | string | Unified identity name (lowercased to form the session key `dm:<name>`). |
| `identities[].channels` | object | `{ channelName: chatId }` — maps each channel the identity uses to its chatId. |
| `identities[].replyPolicy` | string | `"last-active"` (reply on whichever channel the identity last messaged from) or a fixed channel name like `"telegram"` / `"imessage"` (always reply there). |
| `sessionModelOverrides` | object | `{ sessionKey: modelId }` — per-session model override, takes precedence over top-level `model`. Keys are session keys (`dm:alice`, `telegram:12345`, etc.). Written by `/model <name>` for the current chat and by the `tomo config` Sessions menu. |
| `maxTurns` | number | Max agent turns per single user message (one turn ≈ one tool-use round). Default `50`. Raise if you see "max turns exceeded" on long tool chains. |
| `mcpServers` | object | External MCP servers keyed by server name. Supports stdio (`command`, `args`, `env`), HTTP (`type: "http"`, `url`, `headers`), and SSE (`type: "sse"`, `url`, `headers`). Environment variables like `${HOME}` expand in `url`, `headers`, `env`, and `args`. |
| `mcpServers.<name>.oauth` | object | Optional harness-managed OAuth for HTTP/SSE MCP servers. Supports `authorizationServer` (optional; omitted = discover from the MCP server), `clientId` (optional if dynamic registration is available), `scopes`, `tokenStoreKey`, `redirectUri`, and `clientName`. Tokens are stored outside agent context in `workspace/secrets/mcp-oauth.json` (`0600`). |
| `mcpAllowedTools` | string[] | Auto-allowed external MCP tools. If omitted, Tomo defaults to `mcp__<server>__*` for every configured external server. Set this to narrow tool access, e.g. `["mcp__github__list_issues"]`. |
| `lcm.nudgeAtPct` | number | Context-usage % at which the harness nudges the agent to run `tomo lcm daily`. Default `70`. Lower = compact earlier and more often. |
| `lcm.nudgeResetPct` | number | Hysteresis reset threshold — the "already nudged" flag clears once usage drops below this %. Default `60`. Must be less than `nudgeAtPct`; invalid values fall back to defaults. |
| `lcm.groupCompactStyle` | string | `"sdk"` (default) or `"lcm"`. `"sdk"` lets the SDK auto-compact group sessions; `"lcm"` opts groups into the same hierarchical LCM flow as DMs (disables SDK auto-compact and fires all three harness nudges: 70% daily, 80% safety net, and the periodic rollup runner). DMs always use LCM regardless. |
| `lcm.dailyFreshTail` | number | Number of most-recent raw user/assistant events kept outside today's daily rollup so mid-day compacts don't wipe warm short-term texture. Default `32`. Counts SDK events (one tool round = multiple events), not user-typed messages. Set to `0` to compact every event into today's block. Past days are always compacted in full regardless of this value. |

## Requirements and overrides

- **At least one channel must be configured** — either `channels.telegram.token` or `channels.imessage.url`. Startup fails otherwise.
- **Env vars override file values** where they exist: `TELEGRAM_BOT_TOKEN`, `IMESSAGE_URL`, `IMESSAGE_PASSWORD`, `IMESSAGE_WEBHOOK_PORT`, `CLAUDE_MODEL`, `TOMO_CITY`, `TOMO_CONTINUITY`, `TOMO_WORKSPACE`, `SESSIONS_DIR`, `HISTORY_LIMIT`, `TOMO_MAX_TURNS`.
- `workspaceDir`, `sessionsDir`, `historyLimit` are env-only — they're not read from the JSON file.
