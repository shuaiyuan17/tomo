# CLAUDE.md

## What is Tomo

Tomo is a personal AI assistant that lives in messaging apps (Telegram, iMessage). It runs as a long-running Node.js daemon on the user's machine, powered by the Claude Agent SDK. Users interact with it exclusively through chat — there is no web UI or terminal UI at runtime.

Published to npm as `tomo-ai`. Installed globally via `npm install -g tomo-ai`.

## Commands

```bash
npm run build                  # tsc — compile src/ → dist/
npm run dev                    # tsx watch, foreground with hot reload
npm run lint                   # eslint (src/ + tests/)
npm test                       # vitest — full suite
npx vitest run tests/<file>    # single test file (shared fixtures in tests/helpers/)
```

## Architecture Overview

```
src/
  cli.ts              # Entry point — commander CLI
  cli/                # Subcommands: start, config, backup, lcm, cron, sessions, etc.
  agent.ts            # Agent orchestrator — ingress, turn dispatch, notifications, context nudges
  agent/              # Turn execution internals:
    turn-runner.ts          # Runs a turn with retry + NO_REPLY silent-reply policy
    live-session-manager.ts # Owns LiveSession lifecycle — create/resume, reset-and-retry
    live-session.ts         # Wraps SDK query() streaming; steering merge/promotion
    delivery-pipeline.ts    # Streams + finalizes outbound messages to channels
    commands.ts             # Chat slash commands (/new, /model, /summon, /login, ...)
    scaffold-filter.ts      # Strips training-scaffold leaks from outbound text
    inbound-markers.ts      # Inbound marker formatters + outlet guard for fabricated ones
    context-nudge.ts        # Pure decision logic for context-usage nudges
    sdk-options.ts          # Builds SDK query options (model, MCP servers, auto-compact policy)
    audience.ts             # DM-session audience tracking (private DM vs summoned group)
    inbound-batcher.ts      # Coalesces messages that pile up behind an in-flight turn
    proactive-send.ts       # send_message service (direct + delegate modes)
    bash-sandbox.ts         # sandbox-exec wrap for Bash on a private-memory-barred turn
    #  plus: session-queue, pending-notes-queue, send-target, permissions, text-utils, claude-login
  router.ts           # IdentityRouter — session key resolution, allowlists, summons
  people.ts           # People registry — person records, alias/handle resolution, auto-binding
  config.ts           # Config from ~/.tomo/config.json + env vars (zod-validated)
  tomo-event.ts       # <tomo-event> envelope for harness-composed messages
  auth.ts             # Anthropic auth resolution (env key > config; subscription or API key)
  channels/           # Channel implementations (Telegram, iMessage via the imsg CLI)
  sessions/           # Persistence (store.ts), key helpers (keys.ts), summon-store.ts
  mcp/                # tomo-internal in-process MCP server (internal-server.ts) + tool factories
                      #   (cron-, people-, recall-, pet-tools); external-config.ts, oauth.ts
  cron/               # Scheduler (30s poll → agent.handleCronMessage) + store (data/cron/jobs.json)
  lcm/                # Context mgmt — compact, stats, prune-tools, blocks (rollups), runner
  continuity.ts       # ContinuityRunner — periodic heartbeats for autonomous behavior
  watch/              # `tomo watch` mission-control TUI: bus.ts (in-process event bus emitters
                      #   publish to), server.ts (NDJSON over ~/.tomo/watch.sock), snapshot.ts,
                      #   client.ts, tui/ (Ink app — feed, vitals sidebar, chat line, log tail)
  metrics/            # Prometheus exporter (exporter.ts, /metrics on 127.0.0.1:9464) + NDJSON
                      #   activity log (activity-log.ts) — both WatchBus subscribers, gated by
                      #   config.metrics; Grafana stack in contrib/observability/
  costs.ts, models.ts, litellm.ts        # /cost reports; model aliases; LiteLLM gateway modes
  jsonl.ts, fs-utils.ts, runtime-paths.ts # JSONL readers; atomic writes; SDK session file paths
  file-lock.ts        # withFileLockSync — advisory cross-process lock for the JSON stores
  version.ts          # VersionChecker — weekly npm registry check, daytime-only notification
  workspace/          # System prompt builder (SOUL.md + AGENT.md + IDENTITY.md + memory)
  logger.ts           # Pino structured logging
```

Runtime data lives at `~/.tomo/` (config, sessions, cron jobs, logs, workspace, memory).

## Key Design Patterns

### Session Keys

Session keys determine conversation isolation:
- **With identity**: `dm:<identityName>` — unified across all channels (Telegram + iMessage share one session)
- **Without identity**: `<channel>:<chatId>` — e.g., `telegram:123456789`
- **Group chats**: always `<channel>:<chatId>` — never unified

The `IdentityRouter` resolves (channel, chatId, isGroup) → sessionKey + replyTarget.

**Transcript filenames** are derived from the key by `transcriptFileStem()` (`src/sessions/store.ts`) — `<stem>.jsonl` active, `_archive_<stem>_<YYYY-MM>.jsonl` rotated — and the mapping is INJECTIVE **up to case folding**, which the old `key.replace(/[^a-zA-Z0-9_-]/g, "_")` was not (`imessage:any;-;alex.smith@x` and `imessage:any;-;alex_smith@x` shared one file). A key drawn only from `[a-z0-9:-]` keeps that legacy stem; anything else — including any key carrying an uppercase letter, because APFS and NTFS are case-insensitive by default — gets `<legacy stem>.<12 hex of sha256(key)>`, and since `.` is outside the legacy safe set the two families can never meet. So the "never moves" set is **keys drawn from `[a-z0-9:-]`**, not `dm:*`/`telegram:*` as a whole: `dm:shuai` and `telegram:-100123` keep their names, but a non-canonical identity key like `dm:shuai yuan` does move (and is migrated). Never build a transcript path from a key by hand — go through the store, or through the exported `transcriptFileStem` / `legacyTranscriptFileStem`.

Files written under the old scheme are migrated **lazily, on the first touch of a key** (`ensureTranscriptMigrated`, called from `get()`, under the `_transcripts.lock` advisory lock, and never throws on the message path). **The migration only ever renames — it never rewrites a transcript.** Ownership decides, compared case-folded because APFS and NTFS are: if no other key we know of maps to the same legacy stem, the active file, every archive and every sidecar are renamed over. If one does, the stem is AMBIGUOUS, and nothing is merged or guessed.

Four things that look like details and are not:

- **Legacy history that cannot be renamed into place is kept as a read-only sidecar.** When the destination name is already taken (a migration deferred by a held lock, while the message that triggered it appended under the new name), the legacy file is renamed once more — to `<stem>.legacy-<YYYYMMDD-HHmmss>.jsonl`, or `_archive_<stem>_<YYYY-MM>.legacy-<ts>.jsonl` for an archive. **It is searched and loaded, never appended to or rotated.** `loadTranscript`, `searchTranscript`, `transcriptCreatedAt` and `countRecentUserMessages` read sidecars (via `transcriptReadSet`); `append`, `getLastSeq`, rotation and `archivesForStem` must NOT — which is why `seq` uniqueness is only required within the active file and its rotation family. If you add a reader, add it to `transcriptReadSet`; if you add a writer, keep it on `transcriptPath` + `archivesForStem`.
- **A SIDECAR IS NOT NECESSARILY OLDER THAN THE FILE IT SITS BESIDE.** A re-key sidecars a transcript that ran *in parallel* with the one it lands next to, and an unmigrated process keeps appending to a legacy active file. So nothing may infer time order from the read set's filename order: with a sidecar present, `searchTranscript` has no cross-file early exit and sorts by record timestamp, `loadTranscript` sorts the tail it merged, and `transcriptCreatedAt` takes a minimum. `seq` bounds apply to the **active family only** (a sidecar is a separate run, so its numbers are not comparable) and are ignored for sidecar records. Without a sidecar on disk, the old ordered fast paths run unchanged — keep it that way, they are what every message pays for.
- **The migration's one move is `link` then `unlink`, never check-then-rename.** `existsSync(to)` + `renameSync` has a window another process's `append()` fits into, and the rename then overwrites a live transcript silently. `moveWithoutClobber` lets the kernel answer: EEXIST → the destination is taken → sidecar; same device+inode → our own interrupted move → just `unlink`. Only a filesystem that cannot hard-link falls back.
- **Quarantine and ledger repair are never "recorded and assumed".** The `.ambiguous-` marker says the decision was taken; the family is rescanned on every attempt and pre-decision files (newest record older than the marker's timestamp) are still parked. And one unreadable ROW in `_legacy_stems.json` defers only that stem — the row is carried verbatim into a `.corrupt-<ts>` sibling from the READ path and the good rows are kept; nothing is ever rebuilt from `{}` over a quarantined copy.
- **Ownership is read from `_legacy_stems.json`, not inferred, and an unreadable source is not an empty one.** The registry forgets keys — `cleanupExpired` drops an unlinked entry after 30 days while the transcript file stays, `clearSdkSessionId` deletes a metadata-only stub, `migrateSessionKey` re-keys in place — so all three write the key's legacy stem to that ledger *before* forgetting it, and refuse to forget when the write fails. `probeLegacyStemOwnership` reads the ledger, the registry and the session cache, and returns `unknown` (→ migration deferred, nothing adopted) when either file exists and will not parse. Any new path that removes a registry entry must record first, or a shared legacy file becomes silently adoptable again.
- **A key that KEEPS its legacy stem is checked too.** `dm:a:b` keeps `dm_a_b.jsonl` and `dm:a_b` takes a suffix, so the stable key is the one sitting on the shared file. It cannot leave the file where it is, so the family is parked as `<stem>.ambiguous-<ts>.jsonl` — unreachable, preserved, and itself the record that the decision was taken (without that marker, every restart would park the fresh history again).
- **A key is marked migrated only once the migration finished, and an unsettled key's answer is used.** An attempt that could not complete (transcript lock held by another process, EACCES, an unreadable ownership source) is retried, throttled by `TRANSCRIPT_MIGRATION_RETRY_MS`, and reported by `store.migrationStatus()` (`{settled, deferred, ambiguous, sidecars, orphans}` — the last three read off disk and logged on daemon start, the first two only meaningful once keys have been touched, so they are logged again five minutes in). While the probe's answer for a key is `shared` and its family is not parked yet, `get()` serves an EMPTY session and `searchTranscript` nothing: that key's own filename holds another session's history. `append` still writes there — the one window in which a known-shared file grows — and those records are parked with the family. Marking first and then refusing the both-exist case is what left a whole history on disk but unreachable from `loadTranscript` / `searchTranscript` / `transcriptCreatedAt` / `getLastSeq`.

### DM vs Group Detection

Use the helpers in `src/sessions/keys.ts` — don't re-parse keys by hand:
- `isDmSessionKey(key)` — true for `dm:` keys
- `parseRawSessionKey(key)` — `<channel>:<chatId>` → `{ channelName, chatId }` (undefined for `dm:` keys)
- `isGroupSessionKey(key)` — Telegram chatId starts with `-`; iMessage GUID contains `;+;`

### Live Sessions (SDK Integration)

`LiveSession` wraps the Claude Agent SDK `query()` call with an async generator for streaming multi-turn conversations. Key flow:
1. `getOrCreateLiveSession(key)` — reuses existing session or creates new one (with optional SDK session resume)
2. `session.send(text)` — sends a user message, returns the full assistant response
3. `runWithRetry(key, prompt)` — send with auto-retry on session errors (resets and retries once)

SDK session IDs are persisted in the session registry so conversations survive daemon restarts. Every mutator goes through the private `mutateRegistry(op, mode, fn)`, which holds an advisory cross-process lock (`_sessions.json.lock`, `src/file-lock.ts`) for the whole load→mutate→save and forces a fresh read inside it (bypassing the mtime/size stat cache) — the daemon and a short-lived CLI (`tomo sessions clear`, identity migration) write the same file, and publishing a whole-snapshot copy read before the other's write is a lost update no atomic rename can prevent. A lock that cannot be taken follows the same split as an unreadable file: link-changing mutators throw, bookkeeping logs once and skips. A registry that cannot be read is not an empty one: `loadRegistry()` separates ENOENT (legitimately empty) from a read/parse failure, keeps the last known-good state in memory, and and refuses to persist until a later load succeeds — so one unreadable instant can no longer be persisted as `{version:1,sessions:[]}`. How it refuses depends on the mutator: bookkeeping (`updateStats`, `touchSession`, `setChatTitle`, `addParticipant`, `setReplyTarget`) skips silently because it runs on the inbound and turn-completion paths where a throw drops a message or fails a good turn; link-changing (`setSdkSessionId`, `clearSdkSessionId`, `retireSdkSessionId`, `migrateSessionKey`) throws `SessionRegistryReadError`. Both guard *before* mutating, so nothing is left applied-but-unsaved.

With config `steering` (default on), user messages that arrive mid-turn bypass the per-session queue via `session.steer(text)` — they either merge into the in-flight turn or are promoted to their own follow-up turn. Details (STEER_MERGED sentinel, replay detection, idle-wait) live in `src/agent/turn-runner.ts` and `src/agent/live-session.ts`; set `steering: false` or `TOMO_STEERING=false` to keep mid-turn messages queued.

### Message Flow

1. Channel receives message → `agent.enqueueMessage()` (serialized per session key)
2. `handleMessage()` — allowlist check, identity resolution, timestamp injection
3. `runWithRetry()` → `LiveSession.send()` → SDK query; each completed assistant content block ships to the channel as the SDK closes it (no partial-token streaming — `includePartialMessages` stays off)
4. After the `result` event the joined response drives only the transcript, logging, and silence/error policy (`src/agent/turn-runner.ts`, `src/agent/delivery-pipeline.ts`)

### Harness Message Envelope

All harness-composed messages (cron, heartbeats, nudges, summons, delegate requests) are wrapped in a `<tomo-event type=... name=... ts=...>` envelope by `formatTomoEvent()` (`src/tomo-event.ts`) — the single composer; never hand-roll `System:` strings. Bodies are injection-escaped so user-controlled text can't close the envelope early. Consumers must tolerate BOTH the envelope and the legacy `System:` / `[System: ...]` formats — old transcripts are never migrated. Outbound, `src/agent/scaffold-filter.ts` strips training-scaffold leaks before text reaches a channel, and `src/agent/inbound-markers.ts` catches the mirror-image failure: the model WRITING one of the harness's own inbound markers (`[imessage · …]`, `[group "X"] Sender:`, `<tomo-event …>`, `System: …`) into its reply and then answering it as if a person had typed it. That one is **marked, not truncated** — the block ships whole with `FABRICATED_MARKER_NOTICE` prepended to the DELIVERED copy only; the transcript and every classification keep the model's verbatim words. Only lines that *start* with a shape and sit outside a ``` / ~~~ code fence count (fences matched per CommonMark on both ends; any line-break convention; leading invisibles count as indentation), so discussing or pasting these markers is safe. Both outlets for model-authored text run it — reply blocks (`LiveSession.shipBlock`) and `send_message` direct mode (`ProactiveSendService.sendToSession`); delegate mode goes through a real turn and needs nothing extra. It also owns `formatInboundStamp` / `formatGroupTag`, the formatters the ingress path uses to build those markers in the first place, so detector and producer cannot drift.

### Sending Notifications (No Agent Query)

`agent.sendNotification(text)` sends a direct channel message without invoking Claude:
1. Tries `dm:` session via IdentityRouter
2. Falls back to first non-group session key from the registry
3. Uses `privateReplyTargetFromSessionKey()` (`src/sessions/keys.ts`) which excludes groups

Use this for system-level notifications (version updates, errors) that don't need AI processing.

### People Registry (Group Sender Recognition)

Person records live at `~/.tomo/workspace/memory/people/*.md` (DM-only records under `memory/private/people/`) — frontmatter holds `name`, `aliases`, per-channel handles, an optional `timezone`; freeform notes below. Resolution is harness-side and deterministic (`src/people.ts`): channels attach a stable `senderId` to every message, group transcript lines are annotated inline (`ali ✨ (Alice Example): ...`), and handles auto-bind the first time a sender's display name unambiguously matches an unbound public record. The agent maintains records via `list_people` / `upsert_person` MCP tools; a roster (names + aliases + time zone) is injected into every system prompt. `timezone` is an IANA REGION identifier (`src/timezone.ts` validates it and drops unusable values with a single log line; fixed offsets, the `Etc/` namespace and the legacy all-caps aliases are refused because they carry no DST rules). `list_people` reports a stored value that fails validation as `timezone_invalid`, so the model can repair the record it is otherwise told to ignore. It reaches the model twice, and the split is deliberate: the CACHED system prompt (roster, group participants) carries the identifier only, never a clock reading, while the per-message inbound stamp — which varies anyway — carries the sender's live local time (`[imessage · Wed 09/02 20:50 PDT · sender 09/03 12:50 GMT+9]`), omitted when the sender has no time zone or reads the same clock as the host. Private records never enter group flows — excluded from group prompts, group-session tools, and file reads (private-memory guard hook), even when a summon routes group messages into a `dm:` session. The bar is decided in one place (`privateMemoryBarFor`, `src/agent/permissions.ts`) and enforced on both sides of the turn: inbound, the PreToolUse hook denies the file/search tools by path and **sandboxes Bash** — the command is rewritten via the hook's `updatedInput` to run under a `sandbox-exec` profile that denies `memory/private/` (reads and writes) in the kernel (`src/agent/bash-sandbox.ts`), because no filter over command text can scope a shell away from a directory (`node -e` and friends assemble a path the token scan never sees) but `open(2)` on the resolved path can. The profile is written once per process under `~/.tomo/data/bash-sandbox.sb` (mode 0600) against the `realpath` of the private dir; if `sandbox-exec` is missing or the profile cannot be written the fallback is the old outright deny, never an unsandboxed shell. Outbound, a `MEDIA:` attachment is a read, so `send_message` is refused at the hook and reply delivery drops private paths before the send (`isPrivateAttachmentPath`, `blockPrivateMedia` on the delivery pipeline).

### System Prompt

Built by `workspace/index.ts` from layered markdown files:
- `SOUL.md` — personality and values
- `AGENT.md` — operating rules
- `IDENTITY.md` — name and quirks
- Memory system — injected from `~/.tomo/workspace/memory/`
- Harness instructions — NO_REPLY, MEDIA: tags, formatting rules

Changes to workspace files take effect on next message (no restart needed) — the prompt is rebuilt on each new LiveSession.

### Daemon Lifecycle

`tomo start` defaults to background (spawns detached child with `--foreground`). On macOS, `tomo config` can enable launchd autostart (LaunchAgent plist at `~/Library/LaunchAgents/ai.tomo.plist`).

`startForeground()` in `cli/start.ts` is the real entry point — it:
1. Creates Agent, adds channels
2. Starts CronScheduler, ContinuityRunner, VersionChecker
3. Writes PID file
4. Handles SIGINT/SIGTERM for clean shutdown

### Cron System

Users ask Tomo to schedule things via chat. The agent CRUDs jobs with the `schedule_create` / `schedule_list` / `schedule_remove` MCP tools (`src/mcp/cron-tools.ts`), backed by `~/.tomo/data/cron/jobs.json` (the `tomo cron` CLI is a parallel surface on the same store). The `CronScheduler` polls every 30s and fires due jobs via `agent.handleCronMessage()`, which delivers the response through the appropriate channel. A run is recorded on disk *before* it is dispatched (`markStarted`), so a daemon that restarts mid-run can tell "was running" from "never ran": on start, `recoverInterrupted()` settles those runs before any due-scan — a recurring job fires once with a `[resumed]` note in the event body (bounded by `MAX_RESUME_ATTEMPTS`), a one-shot is disabled rather than fired a second time, and `schedule_enable` is how a disabled job is brought back. Store writes hold an advisory cross-process lock (`jobs.json.lock`, `src/file-lock.ts`) for the whole read-merge-write, so the daemon and a `tomo cron` CLI can never be inside one at the same time; within it, writes still merge three-way against the file under an optimistic `revision` check (re-verified just before the rename, now belt-and-braces against writers that skip the lock), so a CLI process with a stale snapshot cannot erase a dispatch record. An unreadable file throws rather than reading as empty. A recurring (`every`) interval is bounded by `MIN_EVERY_MS` (30s — equal to the poll, since a job cannot fire more often than the scan that dispatches it) and `MAX_EVERY_MS` (366 days, which also catches intervals that multiply past `Number.MAX_SAFE_INTEGER`); the bound is enforced in `unschedulableReason` for the creation surfaces, in `CronStore.add` for anything that skipped them, and on `load()`, where a job already on disk with a bad interval is held disabled (warn logged once) instead of firing or failing the whole read.

### LCM (Lifecycle Management)

Custom context management that operates on the SDK's JSONL session files directly (`src/lcm/`):
- `compact.ts` / `stats.ts` / `prune-tools.ts` — range summarization, usage breakdown, tool-result pruning
- `blocks.ts` + `runner.ts` — hierarchical rollups (daily → weekly → monthly → yearly summary blocks); the runner nudges the agent when a completed period is due for promotion

Any code path that rewrites a JSONL file it just read must call `parseJsonl(text, { preserveUnparseable: true })` and write records back with `serializeJsonlRecord` — the default tolerance drops malformed lines, which is fine for a reader and permanent data loss for a rewriter. Opting in widens the element type to `(T | RawJsonlLine)` (see the exported `SdkEntry`), so the compiler forces you to narrow with `isRawJsonlLine` before touching any field. Call `reportRawJsonlLines` after parsing so preserved corruption is visible in the logs. Read-only consumers keep the default.

The harness emits context nudges at `lcm.nudgeAtPct` usage (default 70%, `src/config.ts`), escalating prune → daily rollup → full compact at 80% (decision logic in `src/agent/context-nudge.ts`).

## Code Conventions

- ESM throughout (`"type": "module"` in package.json)
- TypeScript strict mode
- Imports use `.js` extensions (Node16 module resolution)
- Logging via `log` from `./logger.ts` (pino) — use `log.info`, `log.warn`, `log.error`, `log.debug`
- No default exports — always named exports
- Config values are zod-validated: invalid entries collect into `configIssues` and `assertConfigValid()` refuses daemon startup (repair commands like `tomo config` still run)
