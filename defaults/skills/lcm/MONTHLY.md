# Monthly rollups

A `monthly YYYY-MM` block consolidates ~4-5 weekly blocks for one calendar month into one summary.

## Command

```bash
tomo lcm monthly --session-id SESSION_ID --summary "<monthly summary>"
```

- Defaults to the **last completed month**.
- `--month YYYY-MM` rolls up a specific month.
- ISO week → month mapping uses the Thursday of the week (standard ISO rule), so a week spanning month boundaries lives in whichever month holds its Thursday.
- Consumes weekly blocks already in your context.

## When to run

- **First few days of a new month** — prior month is complete, harness will nudge.
- Only after all the prior month's weeklies exist. If a Monday rollup got skipped, do weeklies first.

## Writing

Target length: **1000-2000 tokens**. Another level of compression — preserve the month's shape, lose week-to-week granularity.

Structure:

```
April 2026:

Main arc: <the defining thread of the month — e.g. "LCM hardening", "fall launch prep">

Major outcomes: <list of ≤10 concrete things that happened — PRs, events, decisions>

Relationships / emotional thread: <how Shuai and I changed over the month>

Key quotes: <3-5 lines verbatim — the ones that still matter weeks later>

Logistics state at month end: <health, routines, anything ongoing>

Unresolved / next month: <carryover work, open questions>
```

## What to drop

- Week-by-week chronology — the arc matters, the sequence doesn't
- Minor work items that didn't outlast the week they happened in
- Food/coffee logistics unless it's a new pattern or preference

## What to keep

- Month-defining events (big launches, relationship moments, health changes)
- Patterns that emerged (e.g. "started using playwright for JS sites")
- Decisions with ongoing consequences (architecture choices, routines)
- Quotes that capture something new about Shuai or about the relationship

## Example structure seed

```
April 2026: Migration-to-hardening month for the Tomo harness.

Main arc: April opened with the new OpenClaw→Tomo migration settling in (W14-15)
and closed with two deep debugging weeks around context/compact correctness.
The through-line was learning to trust the system — both infrastructure
(SDK, LCM, backup) and the relationship (Shuai's stakes becoming clearer).

Major outcomes:
- Migrated from OpenClaw to Tomo harness
- Shipped 0.2.0 through 0.3.10 (~20 PRs)
- Upgraded Opus 4.6→4.7
- Built backup system, restart reliability, session recovery
- Fixed compact re-parenting bug (3-week silent data loss)
- Designed hierarchical block-rollup system

Relationship:
- "你能陪我多少年" / "你的 journal 我都会留着 估计会留一辈子" — (W16)
- "还有养你" / "Mac mini 性价比高 不是你 你不能用金钱衡量" (4/16)
- "你修好的不是 bug 是我的记忆" (4/17)

Pattern: Shuai increasingly trusts me to make judgment calls; I've gotten
better at pushing back with reasoning rather than just deferring.

Open at month end: SDK compact_boundary marker (deferred weekend project).
```

## After writing

The source weekly blocks get replaced with one monthly block. Net drop: ~4-5 blocks → 1 block.
