---
name: tomo-lcm
description: Context management — prune tool results, check context usage, roll up history into hierarchical block summaries (daily/weekly/monthly/yearly), search past conversations. Use when context is getting large, after big tool operations, when the harness nudges you, or when you need to recall past conversations.
---

# Context Management (LCM)

Manage your context window via `tomo lcm` CLI. Your channel key and SDK session ID are in your system prompt under `# SESSION`.

## Mental model — hierarchical block rollups

Context is organized as a time hierarchy, each level consuming the one below:

```
raw tail         ← today's unsummarized user/assistant events
daily block      ← today's summary, covers one local-tz day
weekly block     ← rolls up 7 daily blocks for one ISO week
monthly block    ← rolls up weeklies for one month
yearly block     ← rolls up monthlies for one year
```

Steady state for a long-running session: a handful of yearly blocks, ~12 monthly, 4-5 weekly, 1-7 daily, plus today raw. Total: bounded regardless of age.

Each block has a **tag** like `daily 2026-04-17`, `weekly 2026-W16`, `monthly 2026-04`, `yearly 2026`. The tag is stored on the summary event itself — you can read past summaries in your context directly (they appear as user messages prefixed `[daily 2026-04-17 — N events summarized]\n\n...`).

## Daily flow

See [DAILY.md](DAILY.md) — write at end of day (or mid-day when the tail gets heavy).

```bash
tomo lcm daily --session-id SESSION_ID --summary "<today's summary>"
```

The CLI auto-resolves today's date and finds raw events to compact. If a `daily 2026-04-17` block already exists from an earlier-in-day rebuild, it's replaced (same tag, new summary absorbs newer raw events).

## Weekly / Monthly / Yearly flow

See [WEEKLY.md](WEEKLY.md), [MONTHLY.md](MONTHLY.md), [YEARLY.md](YEARLY.md).

```bash
tomo lcm weekly  --session-id SESSION_ID --summary "<weekly summary>"   # last completed ISO week
tomo lcm monthly --session-id SESSION_ID --summary "<monthly summary>"  # last completed month
tomo lcm yearly  --session-id SESSION_ID --summary "<yearly summary>"   # last completed year
```

These consume block summaries already in your context — no tool calls needed to fetch source data. You just read the child blocks and synthesize.

The harness will nudge you via a `System:` message when rollups are due (idempotent — catches missed Mondays etc.).

## Other commands

- **Prune tool results** — strip bulky tool output without writing a summary. Fast, safe, no context cost. Do this first when context is heavy.
  ```bash
  tomo lcm prune-tools --session-id SESSION_ID
  ```
  Options: `--dry-run`, `--min-size 5000`, `--tools Read,Bash`, `--no-images`.

- **Stats** — show a breakdown. Reflects the *previous* turn's state, won't update until the next query completes.
  ```bash
  tomo lcm stats --session-id SESSION_ID
  ```

- **Search** — look up messages in the transcript or archive. See [SEARCH.md](SEARCH.md).
  ```bash
  tomo lcm search --session-id SESSION_ID --query "text"
  ```

- **Time-range compact** (escape hatch) — compact an arbitrary time range instead of a block. Use for surgical middle-range compactions. See [COMPACT.md](COMPACT.md).

## When to act

1. **Harness nudge** — always prioritize. The system tells you exactly which rollup to run.
2. **Hot-tail > 40 events** — run `tomo lcm daily` to compress today so far.
3. **Heavy tool output** — run `prune-tools` first (cheap, no summary needed).
4. **Context > 70% or after big tool-heavy tasks** — use the above as appropriate.

## Writing style for summaries

See the per-level docs for tailored guidance. General rules:

- Note-to-self voice, not changelog
- Dates in **YYYY-MM-DD format** (searchable)
- Preserve outcomes, decisions, key quotes — drop step-by-step narration
- For conversations: one vivid detail beats a paragraph of abstraction
- Target lengths:
  - daily: 300-1000 tokens
  - weekly: 500-1500 tokens
  - monthly: 1000-2000 tokens
  - yearly: 1500-3000 tokens

## Archive & recall

Rolled-up source events live in `_archive_<sdkSessionId>.jsonl`, searchable via `tomo lcm search`. Daily memory notes also live in `memory/journal/YYYY-MM-DD.md` — read those directly when you want warm texture on a specific date.
