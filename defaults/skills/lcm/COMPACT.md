# Compacting Sessions (time-range, escape hatch)

Replace an arbitrary time range with a summary. **Prefer `daily`/`weekly`/`monthly`/`yearly`** ([DAILY.md](DAILY.md), [WEEKLY.md](WEEKLY.md), [MONTHLY.md](MONTHLY.md), [YEARLY.md](YEARLY.md)) for routine rollups — they auto-resolve the range and tag.

Use `compact` only for surgical middle-range compactions (e.g. compact a 2-hour tool-heavy debugging session that happened in the middle of an otherwise-light day, while keeping the rest of the day raw). The block rollups can't express "compact only this slice in the middle of today" — this command can.

## Usage

```bash
tomo lcm compact --session-id SESSION_ID \
  --from-time "2026-03-28T16:29" \
  --to-time "2026-03-28T19:09" \
  --summary "2026-03-28: Refactored auth module: extracted middleware, added JWT validation, updated 12 routes. Tests passing."
```

- Use timestamps you already know from the conversation — no need to run `stats` first
- Times are interpreted in your **local timezone** when no `Z` / offset is given (e.g. `2026-03-28T16:29` = local). Append `Z` for UTC.
- If copying from `stats` output (`2026-03-28 16:29`), replace the space with `T` → `2026-03-28T16:29`
- Originals are archived and searchable via `tomo lcm search`

### Joining the rollup hierarchy

By default the resulting summary is a "legacy" block (no `blockTag`), so it won't be picked up by `weekly`/`monthly`/`yearly` rollups. If you want the consolidated summary to live inside the hierarchy, pass `--block-tag`:

```bash
# Consolidate late-March through mid-April legacy blocks into a monthly:
tomo lcm compact --session-id SESSION_ID \
  --from-time 2026-03-24 --to-time 2026-04-17 \
  --block-tag "monthly 2026-04" \
  --summary "..."
```

Use the canonical tag formats: `daily YYYY-MM-DD`, `weekly YYYY-Www`, `monthly YYYY-MM`, `yearly YYYY`. That way `monthly` → `yearly` promotions can chain naturally.

## Writing good summaries

- Write like a note to your future self, not a changelog
- Include dates in **YYYY-MM-DD format** for searchability
- Record *outcomes* and *key decisions*, not every step
- Tool-heavy sections: one sentence on what was attempted and whether it worked
- Conversations: preserve a key quote or specific detail over a paragraph of abstraction

## Daily memory notes

After compacting, write a brief note to `memory/YYYY-MM-DD.md` for each date covered:

```markdown
## 2026-03-29 — from LCM compact

- Completed auth refactor: JWT middleware extracted, 12 routes updated
- Discussed deployment strategy — decided on blue/green
```

Two-layer recall:
1. **`memory/YYYY-MM-DD.md`** — read directly, no tools needed
2. **`tomo lcm search`** — for raw original messages
