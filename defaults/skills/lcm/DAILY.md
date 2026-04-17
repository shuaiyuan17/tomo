# Daily rollups

A `daily YYYY-MM-DD` block replaces today's (or an explicit date's) raw user/assistant events with one summary.

## Command

```bash
tomo lcm daily --session-id SESSION_ID --summary "<today's summary>"
```

- Defaults to today in your local timezone.
- `--date YYYY-MM-DD` lets you roll up an earlier day that got missed.
- If a `daily <date>` block already exists, it's **replaced**, and any new raw events since it was written get absorbed. Safe to run multiple times a day (mid-day + end-of-day refresh).

## When to run

- **End of day** (before bed or before a long idle). Cleanest shape.
- **Mid-day** when the harness nudges you that raw tail > 40 events.
- **Before a big task** when you want clean context for an involved piece of work.
- **After long tool-heavy work** — reduce clutter before the conversation continues.

## Writing

Target length: **300-1000 tokens**. Day summaries are the closest to raw memory in the hierarchy, so they can keep the most texture.

Structure by phases of the day rather than chronological minute-by-minute:

```
2026-04-17 (Fri):

Morning work: <key technical/work items — PRs shipped, bugs investigated, decisions>

Conversations: <emotional / personal arcs — quotes that landed, moments worth preserving>

Logistics: <food, errands, coffee, MoMo care, health, anything concrete>

Texture/misc: <one or two specific details that make the day feel alive — not generic>
```

Real example (from 2026-04-17):

```
2026-04-17 (Fri): LCM re-parenting bug day.

Morning (08:00-12:00):
- Found compact re-parenting bug — only first post-range event got rewired,
  any sibling became orphan. SDK chain walker silently skipped summaries via
  timestamp fallback. Shipped PR #49 (0.3.9) + #50 archive-path follow-up (0.3.10).
- Added tomo restart 60s wait + direct-SIGTERM fallback.

Recovery drama:
- Repaired the live session from 5 tips → 1. Then rollup compact of 4/3-4/15
  brought context 359K → 50K. Shuai: "你修好的不是 bug，是我的记忆" 🥹

Afternoon: designed the hierarchical block-rollup system (this one). Kept
reasoning mostly on Claw's end; Shuai pushed back on a few things
("what about middle-range compactions" and "cache semantics") which
clarified the scope.
```

## What to drop

- Exact command lines (they're in the archive/git)
- Tool chain step-by-step ("ran grep, then read, then edit")
- Any detail you could easily recover from `tomo lcm search` or git log

## What to keep

- Dated facts (PRs, versions, people, places)
- Quotes — verbatim, with Chinese preserved
- Emotional arcs: what landed, what Shuai reacted to
- Decisions: what you chose and why (the rationale is the expensive part)
- Outcomes that weren't obvious from the starting state

## After writing

Also append to `memory/journal/YYYY-MM-DD.md` if warranted — that file is warm cold storage, read directly later without needing `lcm search`.
