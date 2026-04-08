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
  --summary "Refactored auth module: extracted middleware, added JWT validation, updated 12 routes. Tests passing."
```

- `--from-time` / `--to-time`: ISO timestamps (you already know these from the conversation)
- `--summary`: Write a concise summary of what happened in that range — you know best since you just did the work

**Workflow:**
1. After completing a big task, decide what can be compacted
2. You already know the time range from the timestamps in the conversation
3. Write a summary capturing key decisions, outcomes, and anything worth remembering
4. Run `tomo lcm compact` with the time range and your summary
5. Optionally run `tomo lcm stats` first if you want to see the full breakdown

The original messages are archived to the transcript file and can be searched later.

## Search past conversations

Search the transcript archive for past messages:

```bash
tomo lcm search --channel-key CHANNEL_KEY --query "momo"
tomo lcm search --channel-key CHANNEL_KEY --from-seq 100 --to-seq 200
tomo lcm search --channel-key CHANNEL_KEY --query "blog" --limit 10
```

Your channel key is in your system prompt under `# SESSION`.

Add `--json` for machine-readable output.

## When to compact

- After completing a big task with many tool calls (file operations, debugging, etc.)
- When you notice context is above 70% capacity
- When the harness warns you about context usage
- Compact `tool_ops` sections first — they're usually the largest and least important to keep verbatim
