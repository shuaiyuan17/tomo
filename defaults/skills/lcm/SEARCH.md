# Searching Past Conversations

Search transcript and archived (compacted) messages.

## Usage

```bash
# Search both transcript and archive
tomo lcm search --channel-key CHANNEL_KEY --session-id SESSION_ID --query "momo"

# Search by sequence range
tomo lcm search --channel-key CHANNEL_KEY --from-seq 100 --to-seq 200

# Limit results
tomo lcm search --channel-key CHANNEL_KEY --session-id SESSION_ID --query "blog" --limit 10
```

Always include `--session-id` to search the archive — without it, only the current transcript is searched.

Add `--json` for machine-readable output.
