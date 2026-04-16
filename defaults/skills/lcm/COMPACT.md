# Compacting Sessions

Replace a heavy section of conversation with a summary. Use after `prune-tools` if context is still too high.

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
