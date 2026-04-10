---
name: tomo-lcm
description: Context management — prune tool results, check context usage, compact heavy sections, search past conversations. Use when context is getting large, after big tool operations, or when you need to recall past conversations.
---

# Context Management (LCM)

Manage your context window via `tomo lcm` CLI. Your channel key and SDK session ID are in your system prompt under `# SESSION`.

## Prune tool results and images (fastest)

Strip bulky tool output and base64 images without removing events. No summary needed.

```bash
tomo lcm prune-tools --session-id SESSION_ID
```

Options: `--dry-run` to preview, `--min-size 5000` for only large results, `--tools Read,Bash` to target specific tools, `--no-images` to skip image pruning.

## Check context

```bash
tomo lcm stats --session-id SESSION_ID
```

Stats reflect the *previous* query's state — won't update until the next query completes.

## When to act

1. **First:** `prune-tools` — fast, no summary needed
2. **Then if still high:** `compact` — replaces a section with a summary. See [COMPACT.md](COMPACT.md)
3. **To recall old conversations:** `search`. See [SEARCH.md](SEARCH.md)

Trigger when context is above 70%, after big tool-heavy tasks, or when the harness warns you.
