# Todos

A todo is one thing that can be finished, whose next step is known, and whose next mover is known: Tomo (`me`), the owner (`owner`) or someone else (`external`). They outlive conversations, unlike `TodoWrite`/`TaskCreate`, which are one turn's plan. Ideas, reference notes, timed reminders (use a scheduled task) and recurring work (cron) are not todos.

## Rules

The rules are enforced by the tools (`todo_add` / `todo_list` / `todo_resolve`), not left to the model:

- `todo_add` needs a one-line `title`, a `next` step and `waiting_on`; details go in the file, PR or issue that `ref` points to. There are no notes.
- Every item has a review date (default 3 days when waiting on Tomo, 7 otherwise). Until then it is silent; once it passes, the item is due.
- `todo_resolve` has four actions and no fifth: `done` (optional `evidence`), `drop` (a one-sentence `reason`), `snooze` (`until` and `reason`; may replace `next`) and `handoff` (it now waits on the owner). After 3 snoozes only done, drop and handoff remain.
- At 30 open items `todo_add` refuses and lists the five least recently touched, so one gets resolved first.

## Storage

Items are stored in `~/.tomo/data/todos/todos.json` (rewritten atomically under a file lock, and checked again just before the rename so a writer that got in meanwhile is never overwritten) and `done.ndjson` (one line per finished item, append-only, fsynced before `todos.json` is rewritten; an id found there counts as closed, so a crash between the two writes heals itself and closing twice records once). There is no Markdown copy. A store that cannot be read is reported as an error, never as an empty list.

Tomo cannot write those files directly: on every session a `PreToolUse` guard denies `Write`/`Edit` into the directory and Bash writes into it (redirections, `tee`, `cp`, `mv`, `rm`, `ln`, `sed -i`, `perl -i`, `truncate`, `dd of=`); reading is allowed. See [SECURITY.md](../SECURITY.md#todo-store-what-it-does-not-stop) for what this does not stop.

## Visibility

Each item belongs to the conversation that created it. Your DM sees and resolves all of them; a group sees only its own. The CLI follows the same rule: run from an agent's shell it is limited to the session in `$TOMO_SESSION_KEY` (`--session` can narrow that, not widen it); from a terminal with no key it shows everything.

`tomo todo due` prints at most three due items (oldest first) and nothing when none are due, so a `continuityScript` can call it to bring due items into the heartbeat. Asking the owner about waiting items on a schedule is left to a cron job, for example a weekly one that calls `todo_list` with `filter: "owner"`.

In chat, use [`/todo`](commands.md#todo). The web UI's Study shows the same items read-only ([web-ui.md](web-ui.md#the-study)).

## Limits

Set under `todos` in `config.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `maxOpen` | `30` | Open items at which `todo_add` refuses |
| `maxSnoozes` | `3` | Snoozes per item before only done / drop / handoff remain |
| `titleMaxChars` | `120` | Title length limit |
| `nextMaxChars` | `200` | Next-step length limit |
| `reviewDaysSelf` | `3` | Default days to review for an item waiting on Tomo |
| `reviewDaysWaiting` | `7` | Default days to review for an item waiting on the owner or someone else (also used by `handoff`) |
| `maxReviewDays` | `90` | Furthest a review or snooze date may be set |
| `dueMax` | `3` | Items `tomo todo due` prints by default (`--max` overrides) |
