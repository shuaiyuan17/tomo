# Commands

Two surfaces: the `tomo` CLI on the machine running the daemon, and slash commands you send in a chat.

## CLI

```bash
tomo init              # First-time setup
tomo config            # Interactive settings (authentication, model, LiteLLM, owner, channels, groups)
tomo start             # Start in background (daemon)
tomo start -f          # Start in foreground (for dev)
tomo stop              # Stop the daemon
tomo restart           # Restart the daemon
tomo restart --reason "..."  # Restart and tell the agent why afterward
tomo status            # Show PID and uptime
tomo watch             # Live mission-control TUI (activity feed, vitals, log tail)
tomo logs              # View logs (pretty-printed)
tomo logs -f           # Follow logs live
tomo sessions list     # Show active sessions
tomo sessions clear [key]  # Unlink one session (or all sessions)
tomo cron              # Manage scheduled tasks (add / list / edit / enable / disable / remove / run <id>)
tomo todo due          # Print todos past their review date (max 3; prints nothing when none are due)
tomo todo list         # Print every open todo
tomo continuity        # Manually trigger a continuity heartbeat
tomo lcm               # Context tools (stats / blocks / compact / search / prune-tools / daily · weekly · monthly · yearly rollups)
tomo backup            # Back up all Tomo data (create / list / restore <date>)
tomo usage backfill    # One-off: rebuild the usage ledger's history from the activity log (--dry-run first)
tomo migrate           # Import conversation history from other platforms (openclaw <file>)
tomo update            # Update Tomo to the latest version and restart
tomo uninstall         # Stop Tomo and remove the login item (keeps your data)
```

## Chat commands

These are answered by Tomo itself, without a model call. Replies follow config `locale` (`"en"` or `"zh-Hans"`; unset is English); the command names and reply syntax stay the same in every language. Telegram's command menu is English by default and Chinese for clients set to Chinese.

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation (resets session) |
| `/rewind [N]` | Return to before the last N recorded user messages (default 1; owner's private DM only) |
| `/model` | Switch model (Claude aliases, direct model IDs, or LiteLLM `provider/model` names) |
| `/restore` | Restore `config.json` from `config.json.bak` and restart |
| `/login` | Refresh Claude login from the owner's private DM (`/login cancel` aborts a pending login) |
| `/mcp` | Show external MCP health; `/mcp login <server>` starts per-server OAuth (owner DM only) |
| `/status` | Show session info (model, channel, message count) |
| `/s` | Sub-sessions (when `subsessions` is on; owner's Telegram or iMessage DM): `/s` lists them, `/s s3` shows one, `/s s3 <message>` talks to it, `/s s3 stop` / `start` / `done` / `model <name>` |
| `/tasks` | List this chat's running tasks and the last 5 finished today (`/tasks all`: all of today). `/task` works too |
| `/todo` | List this chat's open todos; `/todo add <text>`, `/todo done <id>`, `/todo drop <id> [reason]`, `/todo all` |
| `/cost` | Show current-session cost for 1d / 7d / 1mo |
| `/usage` | Show Claude subscription usage limits (5-hour and weekly windows + reset countdowns) |
| `/pet` | Check Tomo's pet's mood, growth stage, and stats |
| `/summon` | (groups) Pull your main DM session into this group temporarily |
| `/dismiss` | (groups) Hand the group back to its own Tomo session |
| `/pause` | (groups) Ignore ordinary messages in this group (not read, not remembered) until `/resume`; slash commands, including `/resume`, still work. Any member can use it |
| `/resume` | (groups) Lift a `/pause` |

### `/rewind`

In the owner's Telegram or iMessage DM, `/rewind` branches the conversation before the most recent recorded human message; `/rewind 3` goes back before the last three. All later context is omitted from the new branch. If the chosen message arrived while a tool call was still running, the rewind goes back to the end of the previous complete turn instead, and the reply quotes the message it rewound to. Send your edited request afterward.

No model call or automatic retry is needed, so the command also works after an API refusal. If a turn is still running (for example, stuck after a refusal), `/rewind` stops it first; the stopped turn is not retried and sends nothing more, and anything queued for the conversation runs afterwards on the rewound context.

It does not undo tools, file changes, messages already sent, or persistent memory. Tomo's chat transcript stays intact; the original SDK session follows the normal 30-day unlinked-session retention. Only human messages with recorded provenance in the current context can be selected; compacted or older messages without provenance cannot. Use `/new` to start fresh when that history is unavailable. Rewinding does not guarantee that a subsequent request will be accepted.

### `/tasks`

`/tasks` (or `/task`, any case; `/tasks@yourbot` in Telegram groups) gives the same list as the web UI's Tasks panel (subagents, background shells, monitors, workflows; watchers left out), one plain-text line each — every running task, then the five that ended most recently today (✗ marks a failure). `/tasks all` lists every task that ended today.

Your DM shows your own session's tasks. A group shows only that group's own tasks, never your DM's or another group's — except in a summoned group, where you (the owner) get your own session's list, since the summoned turns run there: it goes to your private DM, and the group sees only "Sent to your DM." It reads the web UI's task board, so it needs the web UI enabled (`web.enabled`, on by default); history starts when Tomo starts. In the web chat itself, `/tasks` is ordinary text (the panel is right there).

### `/s`

With sub-sessions on (`subsessions.enabled`, see [configuration](configuration.md#sub-sessions)), `/s` in your own Telegram or iMessage DM lists your sub-sessions and `/s s3` shows one. `/s s3 <message>` sends that task a message; replying to one of its `[s3 · …]` messages does the same. `/s s3 stop` cancels it, `/s s3 start` starts a queued one now even past `maxRunning`, `/s s3 done` clears a finished task's "Needs you" once you've done what its report asked (`/s s3 done 2`, as `/s s3` shows it, clears only report 2's ask, so a newer report that arrived meanwhile still needs you; a bare `done` means report 1; a task that needs you is not cancelled by `stop`; use `done`), and `/s s3 model <opus|sonnet|fable>` changes its model from its next turn. Only an exact `stop`, `start`, `done` or `model <name>` is a command, so `/s s3 stop the deploy` is a message to the task. Commands answer without a model call. A message to a task that has ended or doesn't exist reaches your main conversation instead, with a note. In groups and the web chat, `/s` is ordinary text.

### `/todo`

`/todo` answers in plain text: what is waiting on you first, then the first ten of Tomo's own, then a count of the rest (`/todo all` lists everything, including what waits on someone else). `/todo add <text>` adds an item waiting on Tomo, with the text as both title and next step (your items are never refused by the open cap, but they count toward it). `/todo done t-12` and `/todo drop t-12 [reason]` close one.

Your DM sees every item. A group sees only its own items, and only you can add, finish or drop there; in a summoned group your full list goes to your private DM and the group sees only "Sent to your DM.". See [Todos](todos.md).

### `/summon` and `/dismiss`

`/summon` in a group routes that group's messages into your main `dm:` session, so Tomo answers with your full personal context. Group-facing replies go through an explicit `send_message` direct call; plain output stays in your private DM. `/dismiss` hands back, and the summon auto-expires after `summonExpiryMinutes` (default 60) of group inactivity. While summoned, the group's turns stay under the [group privacy bar](permissions-and-privacy.md). Design notes: [summon-spike.md](summon-spike.md).
