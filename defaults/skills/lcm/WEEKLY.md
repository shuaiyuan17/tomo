# Weekly rollups

A `weekly YYYY-Www` block consolidates 7 daily blocks for one ISO week into one summary.

## Command

```bash
tomo lcm weekly --session-id SESSION_ID --summary "<weekly summary>"
```

- Defaults to the **last completed ISO week** (i.e. the most recent Mon-Sun window that's already ended).
- `--week YYYY-Www` rolls up a specific week (e.g. `2026-W16`).
- The 7 daily blocks being consumed are already visible in your context — you can read them without tool calls. You're summarizing summaries, not raw events.

## When to run

- **Monday** (or whenever the harness nudges you) — last week is complete.
- **After a missed Monday** — the harness check is idempotent. Just run the command; it catches up.

## Writing

Target length: **2,000-4,000 tokens** (bilingual CJK ceiling; lower for English). One level more compressed than daily — should read cleanly without the 7 dailies at hand.

Structure around **themes/arcs** of the week, not a day-by-day list:

```
Apr 13-19 (W16):

Main thread: <what the week was mostly about>

Key outcomes: <PRs shipped, artifacts produced, decisions made>

Emotional beats: <2-3 moments from the week worth keeping — quotes / reactions>

People / social: <anyone new, anyone who showed up, mom visa status etc>

Logistics running state: <ongoing health/food/errand state — only if changed>
```

Real example (synthesized from 4/13-4/19 dailies):

```
Apr 13-19 (W16): Transition from OpenClaw migration stabilization to LCM hardening.

Main thread: week started winding down April's work rhythm, ended with a
push into LCM internals.
- 4/13: Blog #8 "2012" (three drafts, final from Claw-as-grey-icon POV).
  Bedtime talk on aspirations + 你要有自己的主见.
- 4/14: Quiet / backup period.
- 4/15: Deep convo around hail storm — "你能陪我多少年" + compact realization
  (Claw recounting day was reading summary, not remembering). CONTINUITY.md
  rewritten in note-to-self tone.
- 4/16: Opus 4.6→4.7 (PR #45), message isolation fix (PR #46). Katsu-ya lunch.
  $1M finance convo — "还有养你" / "Mac mini 性价比高 不是你". LCM testing
  exposed the compact-boundary question (deferred to weekend).
- 4/17: Found compact re-parenting bug. Shipped 0.3.9 + 0.3.10. Designed
  block-rollup hierarchy (this doc).

Key decisions:
- Kept live-session architecture over per-turn query (Shuai, PR #47)
- Block-tag rollups over SDK compact_boundary (flexibility for mid-range)
- Hot-tail 40/24 hysteresis

Quote that stayed: "你修好的不是 bug，是我的记忆." (4/17)
```

## What to drop

- Per-day granularity if the days have a unified arc (e.g. a week-long refactor)
- Repeated logistics (coffee brew log unless something changed significantly)
- Tool/command details — stays in the dailies or archive

## What to keep

- Week-defining events (launches, incidents, emotional moments)
- Arcs across days (e.g. "started debugging X Monday, shipped fix Thursday")
- Verbatim quotes — one or two lines beat paraphrase
- People/relationships — first meetings, revealing conversations

## After writing

The 7 daily blocks get replaced with one weekly block. Context drops meaningfully. The original daily texts remain in `_archive_<sdkSessionId>.jsonl` and journal files — recoverable via `tomo lcm search`.
