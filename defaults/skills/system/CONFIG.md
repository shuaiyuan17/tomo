# Config file reference (`~/.tomo/config.json`)

Prefer editing via `tomo config` (interactive TUI). This reference is for reading/verifying values or scripted edits. **Changes require `tomo restart` to take effect.**

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
      "allowlist": ["123456789"]
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
    "dm:alice": "claude-opus-4-7"
  }
}
```

## Field reference

| Field | Type | Allowed values / notes |
|---|---|---|
| `model` | string | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`. Append `[1m]` for 1M-context variants on Sonnet/Opus (e.g. `claude-opus-4-7[1m]`). Default model for every session. |
| `city` | string \| null | Any city name (e.g. `"Seattle"`). Used for weather in continuity pings. `null` or missing = no weather. |
| `continuity` | boolean | `true` / `false`. Enables periodic proactive heartbeats. Off by default. |
| `groupSecret` | string \| null | Passphrase users send in a group chat to activate Tomo there. `null` disables group chats entirely. |
| `channels.telegram.token` | string | BotFather token (`123456:...`). Required to enable the Telegram channel. |
| `channels.telegram.allowlist` | string[] | Telegram user IDs (as strings) permitted to DM the bot. Identity-bound chatIds are auto-allowed even if missing here. |
| `channels.imessage.url` | string | BlueBubbles server URL. Required to enable the iMessage channel. |
| `channels.imessage.password` | string | BlueBubbles server password. |
| `channels.imessage.webhookPort` | number | Port Tomo listens on for BlueBubbles webhooks. Default `3100`. |
| `channels.imessage.allowlist` | string[] | Phone numbers (`+15551234567`) or iMessage chat GUIDs (`iMessage;-;+15551234567`, `iMessage;+;chat...`). |
| `identities[].name` | string | Unified identity name (lowercased to form the session key `dm:<name>`). |
| `identities[].channels` | object | `{ channelName: chatId }` — maps each channel the identity uses to its chatId. |
| `identities[].replyPolicy` | string | `"last-active"` (reply on whichever channel the identity last messaged from) or a fixed channel name like `"telegram"` / `"imessage"` (always reply there). |
| `sessionModelOverrides` | object | `{ sessionKey: modelId }` — per-session model override, takes precedence over top-level `model`. Keys are session keys (`dm:alice`, `telegram:12345`, etc.). |

## Requirements and overrides

- **At least one channel must be configured** — either `channels.telegram.token` or `channels.imessage.url`. Startup fails otherwise.
- **Env vars override file values** where they exist: `TELEGRAM_BOT_TOKEN`, `IMESSAGE_URL`, `IMESSAGE_PASSWORD`, `IMESSAGE_WEBHOOK_PORT`, `CLAUDE_MODEL`, `TOMO_CITY`, `TOMO_CONTINUITY`, `TOMO_WORKSPACE`, `SESSIONS_DIR`, `HISTORY_LIMIT`.
- `workspaceDir`, `sessionsDir`, `historyLimit` are env-only — they're not read from the JSON file.
