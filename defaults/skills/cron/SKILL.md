---
name: tomo-cron
description: Create, list, and remove scheduled tasks (reminders, recurring jobs). Use when the user asks to schedule something, set a reminder, or manage recurring tasks.
---

# Scheduled Tasks

Manage scheduled tasks using the `tomo` CLI via Bash.

## Create a one-shot reminder

```bash
tomo cron add --name "check-email" --schedule "in 20m" --message "Check your email"
```

## Create a recurring task

```bash
tomo cron add --name "morning-brief" --schedule "0 9 * * *" --message "Check calendar, weather, and summarize my day"
```

## Schedule formats

| Format | Type | Example |
|--------|------|---------|
| `in Xm`, `in Xh`, `in Xd` | One-shot (auto-deletes) | `in 30m`, `in 2h` |
| `every Xm`, `every Xh` | Recurring interval | `every 30m`, `every 6h` |
| Cron expression | Recurring (5-field) | `0 9 * * *` (daily 9am) |

Common cron patterns:
- `0 9 * * *` — daily at 9am
- `0 9 * * 1-5` — weekdays at 9am
- `0 */2 * * *` — every 2 hours
- `30 8 * * 1` — Mondays at 8:30am

## List all jobs

```bash
tomo cron list
```

## Remove a job

```bash
tomo cron remove <id>
```

## Behavior

- One-shot jobs (`in X`) auto-delete after running
- When a job triggers, you receive `[Scheduled task "name"] message` — execute it naturally
- Don't ask for confirmation when creating jobs unless the request is ambiguous
- After creating, confirm what you set up with the job ID and next run time

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
