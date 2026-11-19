# Channels, sessions and groups

## One owner, one conversation

Tomo works for one person, the **owner**. Every owner DM — Telegram, iMessage and the web UI — lands in one session, `dm:<owner.name>`, and Tomo replies on whichever channel you last used.

- The owner's session is created up front (by `tomo init`, or on first start), so a channel connected later (`tomo config` → Owner / Channels) joins it instead of starting a new one.
- **Admission fails closed.** Only DMs from the owner's handles are answered. Anyone else gets no reply and no session; Tomo logs one line per sender per hour. A channel with no allowlist is not open.
- iMessage handles are compared in a normal form, so `+1 (555) 555-0123` and `iMessage;-;+15555550123` match.
- `owner.name` is the session id and never changes; set `owner.displayName` for what Tomo should call you.
- `tomo config` → **Owner** shows your session id (read-only), display name, Telegram IDs and iMessage handles. Enabling iMessage in `tomo config` → Channels asks for your handle; going without one needs an explicit confirmation.
- Older configs with `identities` keep working: one identity is read as the owner (same session). With several, `web.ownerIdentity` (or else the first) becomes the owner and Tomo warns at startup; the others' sessions are left untouched but their DMs are no longer answered. Their cron jobs keep firing into those sessions and deliver to that person's last chat (a job whose session has no reply target is skipped with a warning); `tomo config` → Owner → **Convert legacy identities** lists them and offers to disable them.

Sessions resume across daemon restarts (Claude Agent SDK session resume). `/new` starts fresh; unlinked sessions are kept for 30 days before cleanup.

## Group chats

- Each group chat gets its own isolated session, and groups are off until activated: send the secret passphrase (`tomo config` → Group chats) in the group, which adds it to the channel's `allowlist`. The allowlist only lists groups; DM entries in it are ignored. `tomo config` → Channels → **Groups** lists activated groups.
- Group turns never see your private memory and run Bash in a sandbox — see [Permissions and privacy](permissions-and-privacy.md).
- `/summon` temporarily routes a group into your own DM session; `/pause` makes Tomo ignore a group until `/resume`. See [Commands](commands.md#chat-commands).

## Telegram

Needs a bot token from [@BotFather](https://t.me/BotFather).

- DM and group chat support
- Typing indicators with keepalive and error backoff
- Image/photo support (sent to Claude as vision input)
- Group chat defaults to mention-required (only responds when @mentioned or replied to); per-group passive listen mode is opt-in via `channels.telegram.passiveGroups`
- Markdown rendering with plain-text fallback
- Inbound reactions reach Tomo worded like iMessage tapbacks (`[reacting to: "…"] [tapback: love]`). In a group Telegram sends them only when the bot is an admin.

## iMessage

Uses the local [imsg CLI](https://github.com/openclaw/imsg) on a Mac signed in to iMessage, enabled with `channels.imessage.provider: "imsg"`. No external server: Tomo spawns one `imsg rpc` child, so the Tomo process needs **Full Disk Access** (advanced features additionally need `imsg launch`).

- DM and group chat support, with image attachments
- Contact name resolution from Mac contacts
- Group chat observes all messages and only responds when relevant (replies `NO_REPLY` to stay silent)
- Inbound tapbacks and built-in reply context; message editing is gated on a live macOS selector probe

Only the bound handle's DMs are answered; iMessage groups need the group secret (or an explicit `allowlist` entry with the group's chat GUID). Configuration: [configuration.md](configuration.md#imessage).

## Web UI

The optional local web chat (on by default, `127.0.0.1:9465`) is the owner's DM session; groups are read-only there. It also has the Tasks panel, the Study (memory, context, cost, cron, todos, model) and Tomo's 3D home. See [web-ui.md](web-ui.md).

## People registry

Tomo keeps person records at `~/.tomo/workspace/memory/people/*.md` — canonical name, aliases/nicknames, per-channel handles and an optional IANA `timezone` in frontmatter, freeform notes below. Group messages are annotated with the sender's resolved name, and handles auto-bind the first time a sender's display name matches a record — you only ever refer to people by name. When a sender has a time zone, their local time is shown alongside the message timestamp. Records meant for your eyes only live under `memory/private/people/` and never enter group chats. Tomo maintains the registry itself via the `list_people` / `upsert_person` tools.
