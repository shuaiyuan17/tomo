---
name: tomo-lcm
description: Context management — check context usage, compact heavy sections, search past conversations. Use when context is getting large, after big tool operations, or when you need to recall past conversations.
---

# Context Management (LCM)

Manage your context window using the `tomo lcm` CLI via Bash. Use these tools to keep your context clean and retrieve old conversations.

## Session info

Your channel key and SDK session ID are in your system prompt under `# SESSION`. Use them directly in commands — no need to look them up.

## Check context breakdown

See how your context is structured — which sections are conversation vs tool operations, and how many tokens each uses.

```bash
tomo lcm stats --session-id SESSION_ID
```

Output shows sections like:
```
Total: 310 messages, ~180K tokens

Sections:
  #1 | conversation | msgs 0-48 (49)   | ~15K tokens | 23:33-01:15
  #2 | tool_ops     | msgs 49-295 (247) | ~142K tokens | 01:15-03:40 [Read:45, Edit:12, Bash:30]
  #3 | conversation | msgs 296-310 (15) | ~8K tokens  | 03:40-03:52
```

Add `--json` for machine-readable output.

## Compact a section

Replace a heavy section with a summary. Use timestamps to specify the range:

```bash
tomo lcm compact --session-id SESSION_ID \
  --from-time "2026-03-28T16:29" \
  --to-time "2026-03-28T19:09" \
  --summary "2026-03-28: Refactored auth module: extracted middleware, added JWT validation, updated 12 routes. Tests passing."
```

- `--from-time` / `--to-time`: ISO timestamps — you already know these from the conversation, no need to run stats first
- `--summary`: Write a concise summary of what happened in that range — you know best since you just did the work

**Workflow:**
1. After completing a big task, decide what can be compacted
2. Read the time range directly from conversation timestamps — no need to run `stats` first
3. Write a summary capturing key decisions, outcomes, and anything worth remembering
4. Run `tomo lcm compact` with the time range and your summary
5. Optionally run `tomo lcm stats` to verify the result

The original messages are archived to the transcript file and can be searched later.

**Daily memory notes:**

When compacting a section, also write a brief note to `memory/YYYY-MM-DD.md` for each date covered. This creates a fast, human-readable index you can read directly — without needing to invoke any tools.

```bash
# Example: after compacting 2026-03-29
# Append to memory/2026-03-29.md (create if it doesn't exist)
```

```markdown
## 2026-03-29 — from LCM compact

- Completed auth refactor: JWT middleware extracted, 12 routes updated
- Discussed deployment strategy with team — decided on blue/green
- Set up backup cron job
```

Two-layer recall:
1. **`memory/YYYY-MM-DD.md`** — read directly, fast, no tools needed
2. **`tomo lcm search`** — when you need the raw original messages

**Writing good summaries:**
- Use your own natural voice — more like a note to your future self than a changelog
- Always include explicit dates in **YYYY-MM-DD format** for anything date-specific — e.g. "2026-03-29: published first blog post". This makes `tomo lcm search` much more useful later.
- Record *outcomes* and *key decisions*, not every step taken
- For tool-heavy sections (browser loops, exec retries): one sentence on what was attempted and whether it worked
- For conversations: preserve texture — a key quote or specific detail is worth more than a paragraph of abstraction

## Search past conversations

Search the transcript archive for past messages:

```bash
# Search both current transcript AND archive (requires --session-id)
tomo lcm search --channel-key CHANNEL_KEY --session-id SESSION_ID --query "momo"

# Search by sequence range
tomo lcm search --channel-key CHANNEL_KEY --from-seq 100 --to-seq 200

# Limit results
tomo lcm search --channel-key CHANNEL_KEY --session-id SESSION_ID --query "blog" --limit 10
```

Your channel key and session ID are in your system prompt under `# SESSION`.

**Note:** Always include `--session-id` to search the archive — without it, only the current transcript is searched.

Add `--json` for machine-readable output.

## When to compact

- After completing a big task with many tool calls (file operations, debugging, etc.)
- When you notice context is above 70% capacity
- When the harness warns you about context usage
- Prioritize sections with many tool calls (browser, exec, Read/Edit loops) — these are usually the largest and least important to keep verbatim
