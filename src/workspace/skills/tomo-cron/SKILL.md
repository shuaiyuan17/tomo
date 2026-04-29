---
name: tomo-cron
description: Create, list, and remove scheduled tasks (reminders, recurring jobs). Use when the user asks to schedule something, set a reminder, or manage recurring tasks.
---

# Scheduled Tasks

Three MCP tools (`schedule_create`, `schedule_list`, `schedule_remove`) cover the everyday workflow. They live on the `tomo-internal` MCP server and load on demand via tool search — search for "schedule reminder cron" to surface them. The legacy `tomo cron …` CLI stays as a parallel surface for human audit/debug.

## Create a reminder

Use `schedule_create`:

| Field | Notes |
|-------|-------|
| `name` | Short slug (`airplant-weekly-soak`). Used in logs and `cron list`. |
| `schedule` | Free-form string (see formats below). |
| `message` | Text the user/scheduler will see when the job fires. |
| `session` | Routing target — usually the current `Session key` from the system prompt. |
| `once` | Optional override. Defaults to `true` for one-time `at` schedules, `false` for recurring. |

The tool returns the created job summary including the lifecycle (`once` / `recurring`) and `nextRunAt`. Confirm the `Type:` / `lifecycle` line before moving on — that's the silent-drift guard against accidental forever-recurring reminders.

## List jobs

`schedule_list` (no arguments) returns every job in the store as JSON. Each entry includes `id`, `name`, `lifecycle`, `enabled`, `schedule`, `message`, `sessionKey`, `nextRunAt`, `lastRunAt`, `lastStatus`. Use it before adding to avoid duplicates, or to find an `id` for removal.

## Remove a job

`schedule_remove` takes one arg (`id`) and returns `Removed` or `not found`. The `id` comes from `schedule_list`.

## Where does the reminder get delivered? (`session`)

The session key is shown in your system prompt under **SESSION — Current Session Info → Session key**. Pass that value so the fired message is routed back to the right place.

- **User says "remind me"** in a DM or group — use the current `Session key`. For a unified identity (`dm:<name>`), the reply follows the identity's reply policy at fire time, so it will reach them wherever they are most reachable. For a group chat (`imessage:...` / `telegram:-100...`), the reminder fires back into that same group.
- **User says "remind us" / "ping the group"** in a group chat — same deal: pass the current group session key.
- **User says "remind me" in a group chat but clearly means *them personally*, not the group** — prefer the user's unified DM session key if one exists (`dm:<name>`), not the group's key. Otherwise use the group key and accept that the reminder lands in the group.

If in doubt, use the current session's key.

## Schedule formats

| Format | Type | Example |
|--------|------|---------|
| `in Xm`, `in Xh`, `in Xd` | One-shot (auto-deletes) | `in 30m`, `in 2h` |
| ISO date `YYYY-MM-DD[THH:MM]` | One-shot (auto-deletes) | `2026-05-01T19:00` |
| `every Xm`, `every Xh` | Recurring interval | `every 30m`, `every 6h` |
| 5-field cron expression | Recurring | `0 9 * * *` (daily 9am) |

Common cron patterns:
- `0 9 * * *` — daily at 9am
- `0 9 * * 1-5` — weekdays at 9am
- `0 */2 * * *` — every 2 hours
- `30 8 * * 1` — Mondays at 8:30am

### One-shot trap with cron expressions

A cron expression like `0 19 1 5 *` reads as **every May 1 at 7pm forever** — not "this May 1 only". For a single fire on a specific calendar date, prefer:

- **ISO date schedule (preferred)**: `schedule: "2026-05-01T19:00"` — auto-cleans after firing.
- **`in Xd` relative**: `schedule: "in 3d"` — auto-cleans after firing.
- **Cron expression with explicit override**: `schedule: "0 19 1 5 *"`, `once: true` — fires once then deletes.

Without `once: true`, a cron expression with a specific day-of-month + month will silently re-fire every year. The created-job summary surfaces the lifecycle (`once` vs `recurring`) — read it before moving on.

## CLI fallback

The `tomo cron` CLI is the same store with a human-friendly surface. Use it for:

- Auditing / grepping behaviour from a terminal (`tomo cron list`)
- Quick removal when the agent isn't running (`tomo cron remove <id>`)
- Manual creation while testing a behaviour change

```bash
tomo cron list
tomo cron remove <id>
tomo cron add --name "..." --schedule "..." --message "..." --session "..." [--once]
```

The MCP tools and the CLI both write to `~/.tomo/data/cron/jobs.json` — there is no divergence.

## Behavior

- One-shot jobs auto-delete after running. This covers all `at` schedules (`in X`, ISO dates) and any cron expression created with `once: true`.
- When a job triggers, you receive `[Scheduled task "name"] message` — execute it naturally.
- Don't ask for confirmation when creating jobs unless the request is ambiguous.
- After creating, confirm what you set up with the job id, `lifecycle`, and `nextRunAt`.

## Silent execution

If a triggered task doesn't need to notify the user (e.g., background maintenance, checking something that turned out fine), reply with exactly:

```
NO_REPLY
```

This suppresses delivery to the channel. Use it when:
- A check found nothing to report
- A background task completed with no user-visible result
- The task is purely internal (organizing files, updating memory, etc.)

Do NOT use NO_REPLY when the user explicitly asked to be reminded — reminders always need delivery.
