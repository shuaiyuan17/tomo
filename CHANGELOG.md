# Changelog

## Unreleased

### Breaking changes

- **Outbound delivery is no longer streamed, and a reply is one message.** The turn now runs to completion and its SDK content blocks are delivered once: `text` blocks always ship, `thinking` blocks ship only when the new `showThinking` / `TOMO_SHOW_THINKING` setting is on (default `false`, prefixed with `💭`). Delivery is decided by block **type** — nothing pattern-matches the model's outbound words, so a one-word reply like `count` or a text block that opens with `思考:` ships verbatim. A newline inside a reply is now formatting, not a message boundary: a three-line reply arrives as one bubble with two newlines instead of three bubbles, and only the channel's per-message cap (iMessage 4000, Telegram 4096) still splits, at a word boundary and without truncating. `[[NL]]` is still rewritten to a real newline so it can never ship literally, but it is redundant. `StreamingMessage` and every channel's streaming implementation are deleted, as is the `streaming` / `TOMO_STREAMING` setting (Telegram's typewriter edit-in-place goes with them; the typing indicator is unaffected — it was always driven by the turn, not by stream events). NO_REPLY semantics are unchanged: trailing bare `NO_REPLY` line(s) suppress the whole response, media and stickers included, while an inline mention still delivers. Everything that used to run once per streamed block still runs once per block, before the join — the scaffold-leak filter (a leak truncates its own block, not the rest of the turn), the bare-`NO_REPLY` drop (a mid-turn NO_REPLY block is dropped whole, attachments included), and `MEDIA:`/`STICKER:` extraction, so a turn of `A`, `MEDIA:…`, `B` still ships A, then the photo, then B, with a caption riding the media of its own block. Adjacent text-only blocks merge into one send, and reply threading targets the first message that actually ships threaded, whatever its kind: a step that sends nothing (an empty text run, a `MEDIA:` path that does not exist) leaves the target for the next one, and a channel that cannot thread that kind of message says so rather than swallowing it. `showThinking: true` now also asks the SDK for thinking content blocks (`thinking.display: "summarized"` instead of `"omitted"`) — without that the flag had nothing to show on Sonnet/Opus 4.6+. The display is fixed at session spawn, so a mid-session change applies after a restart.

- **The BlueBubbles iMessage backend is removed.** `imsg` replaced it on 2026-07-07 and BlueBubbles has not been exercised since; `src/channels/imessage.ts` and its 1,000-line test file are gone, along with the `channels.imessage.url` / `password` / `webhookPort` settings and the `IMESSAGE_URL` / `IMESSAGE_PASSWORD` / `IMESSAGE_WEBHOOK_PORT` environment overrides. `channels.imessage.provider` survives, because it is the only signal that turns the iMessage channel on, but its value collapses to `"imsg"`. **The default changed**: it used to fall back to `"bluebubbles"`, so any install that never set the key silently selected an unmaintained backend; it is now unset, which means iMessage is off and no `imsg` child is spawned unless asked for. Existing configs carrying `"provider": "imsg"` load unchanged. A config still pinned to `"provider": "bluebubbles"` raises one targeted startup issue naming the removal and the fix, rather than failing the whole `channels.imessage` entry (which would have taken the allowlist with it). The interactive `tomo config` iMessage menu loses its provider picker and BlueBubbles connection prompts, becoming an enable/disable toggle. Comments recording chat.db, IMCore, and Apple behaviour that BlueBubbles happened to surface first were kept and reattributed, not deleted.

### Features

- **Inbound attachments of any MIME type are stored instead of dropped**. A third ingestion path alongside images and PDFs, for everything else. Until now `loadAttachments` filtered on `image/*` or `isSupportedDocumentMime()` and silently `continue`d past anything else, so a `.zip` of SSH keys sent over iMessage on 2026-08-27 reached the agent as a bare object-replacement character — no text, no marker, no indication a file had ever been attached — while the bytes sat unread in `~/Library/Messages/Attachments/`. Unsupported types are now copied to `{workspaceDir}/memory/incoming-files/YYYY-MM-DD/HHMMSS_{session}_{original name}`, the sibling of the image and document stores. Crucially this path is *path-only*: the bytes are not attached to the message and are not sent to the API automatically (a zip is not something the model reads as an attachment, and a 32 MB binary must not be uploaded every turn), so the message carries a single line naming the file, its MIME type, its size and its absolute path, with no attachment carrier of any kind. The agent can still open that path deliberately with `Read`/`Bash` — that is the point of writing it down. New `fileStore.ts` exposes `saveInboundFile`, `formatFileMarker`, `sanitizeAttachmentFilename` and `MAX_FILE_BYTES` (the same 32 MB as `MAX_DOCUMENT_BYTES`); over the cap nothing is written and the notice says so with the size, because the sender believes the file was delivered and silence is what caused the incident. Sender filenames are preserved (`dmit-207121-id_rsa.zip` beats `220446_imessage_….bin`) but treated as hostile — reduced to a basename, so traversal, absolute paths, NULs and leading dots cannot escape the target directory or forge a marker — and writes use the `wx` flag with `name-1`, `name-2` fallbacks so a repeat filename never clobbers an earlier file. The image and document paths are untouched.

  Sender-controlled fields are treated as hostile on both axes, not just the filename: the **MIME type** is rendered by `formatMimeToken` as a strict RFC 2045 `token/token` under a 255-character cap, and anything else is replaced outright with `application/octet-stream` and logged. Previously it was interpolated verbatim, so `application/octet-stream)\n[via satellite — …]` closed the notice's parenthesis and opened a second line that read as a trusted marker. The result additionally passes through `neutralizeMarkerDelimiters` — lifted out of `formatReplyContextMarker`, which already neutralised `[ ] < >` for exactly this reason, and extended to collapse control characters — so the notice is one line with one bracket pair by construction even if the token test is ever loosened.

  A file can no longer go missing quietly. `storeUnsupportedAttachment` always returns a notice: an attachment imsg never resolved a local path for reports `source-unavailable`, and one flagged `missing` reports `source-missing` ("the sender attached it but it never downloaded"). Both are facts the agent should have. Returning `null` for these left nothing recording that a file had been *intended*, so an attachment-only message reached the ghost-row check with no marker and was discarded — the original bug, alive in the failure path.

  **MIME-less rows are no longer assumed to be link previews.** The skip is now gated on a positive discriminator — the `.pluginPayloadAttachment` name suffix or the `dyn.age81a5dzq7y066dbtf0g82peqf4hk2pdrb00n5xy` UTI, both surfaced by imsg. Measured against a live chat.db (1,287 attachment rows), 181 carried no `mime_type`: 162 were payload rows and **19 were real files** — `.jsonl`, `.vue`, `.icon`, and an inbound `AuthKey_….p8` — that macOS has no MIME mapping for and that were being dropped exactly the way the `.zip` was. Unrecognised MIME-less rows are now stored as `application/octet-stream` with "type unknown" in the notice, so the fallback isn't read as a positive identification.

  The unsaved notice no longer contradicts itself: "read from the path if you need it" was appended unconditionally, including to notices that had just said `NOT saved` and had no path. The tail is now conditional on at least one file actually having been written.

- **`saveInboundFiles` config key and `TOMO_SAVE_INBOUND_FILES` env override.** Gates the any-MIME store independently of `saveInboundImages` — the stored bytes are not attached to the message and are not sent to the API automatically (the assistant is told the path and can open it deliberately), so the two are worth separating. **Defaults to the value of `saveInboundImages`** when unspecified, so an install that already opted out of inbound attachment storage stays opted out rather than being quietly re-enabled by a new key. Turning it off does not silence the notice; the agent is still told a file arrived, just without a path to open.

  The opt-out is honoured in exactly one place. The `ImsgChannel` constructor used to re-derive `fileStoreBaseDir` from `imageStoreBaseDir` when it was unset, which meant `saveInboundFiles: false` was silently overridden for anyone leaving `saveInboundImages` at its default of `true` — arbitrary files kept being written despite the explicit opt-out. Undefined now means off, full stop; the "unset follows `saveInboundImages`" inheritance lives only in the config parser.

- **A workspace path that cannot be rendered in an attachment notice is rejected at config load.** The inbound file notice is a single bracketed line by construction, which every sender-controlled field earns by sanitisation — but the saved path is built from `workspaceDir`, and `TOMO_WORKSPACE` is free-form. A workspace path containing a newline or a `]` would have split or truncated the notice. It is now refused at load with a named config issue rather than neutralised in the notice: that path exists to be opened, and substituting a full-width `］` into it would produce a line naming a file that does not exist.
### Bug fixes

- **iMessage threads photos, and a reply target is never lost to a send that didn't happen.** `ImsgChannel` now sends a threaded attachment through `send.attachment` with `reply_to` — the only imsg RPC that threads a file, and bridge-only, so an un-injected Messages.app still ships the picture, just unthreaded. Because threading support on iMessage is per message KIND (text and attachments yes, stickers never: `send.sticker` takes no `reply_to` and the bridge's `stickerReplyTo` selector probes false), `Channel.send` may now return a `SendResult` reporting `threaded: false`, and the delivery pipeline hands the target on to the next message instead of considering it spent. Previously the channel dropped `replyTo` on photos and stickers silently while the pipeline believed it consumed, so a turn of `MEDIA:…` then text arrived entirely unthreaded. The pipeline also no longer retires the target before checking whether there is anything to send, which stranded `STICKER:…` then text, and any `MEDIA:` block whose path did not exist. Telegram was already correct — the Bot API threads every send kind with the same `reply_parameters` — and now has tests pinning it.

  The same rule now covers every fallback out of `ImsgChannel.send`, not just the ones that knew they were dropping a target. A threaded text send that lands on the plain AppleScript `send` — bridge down, `send.rich` refused, or no text to carry it at all — used to return nothing, which reads as "delivered as asked", so the pipeline retired a target that never reached a bubble and nothing later in the turn was offered it. Every such path reports `threaded: false`; only a `send.rich` that actually carried `reply_to` is silent.

  And a captioned photo no longer wastes a turn it could have threaded. Text threading (`send.rich`) and attachment threading (`send.attachment`) are separate bridge surfaces, so an imsg too old for the latter can still thread the caption. When the picture could not take the target the caption is now offered it, and the caption's own result becomes the send's result — which matters most for a final one-block `caption + MEDIA:path`, where there is no later message for the pipeline to reoffer the target to and the whole turn used to end unthreaded. Behind a picture that *did* thread the caption still ships plain: one reply per turn.

- The `showThinking` config reference pointed at a `/reset` command that does not exist; it says `tomo restart`.

## 0.8.14 (2026-08-14)

### Features

- **OAuth-authenticated MCP servers hot-mount into live sessions** (#275). When a background refresh, `/mcp login`, or pasted callback produces a fresh authenticated server config, Tomo now sends every live Agent SDK query that missed the server a replacement-safe full MCP map through `setMcpServers`, preserving already-mounted external servers and the per-session `tomo-internal` instance. Hot-mounts are serialized so simultaneous token completions cannot remove one another, and current-session bookkeeping follows the structured control result so `/mcp` reflects the new mount immediately. Existing session creation remains non-blocking; SDKs without runtime MCP management and rejected control requests log once and retain the next-session fallback.
- **External MCP health and headless OAuth completion** (#272). The owner-only `/mcp` command reports every configured external server's current-session mount state, OAuth expiry, pending flow, and latest auth failure; `/mcp login <server>` starts or reuses that server's background single-flight authorization without disturbing live sessions. OAuth redirects that land on another device's unreachable localhost can now be pasted verbatim into the owner's DM: Tomo routes by the unguessable `state`, completes the exchange with the server-held PKCE verifier, atomically persists the token, consumes the callback before it can enter model context, and confirms the server plus expiry. Callback states remain ten-minute, single-use credentials; groups never invoke paste-back handling, and a bare `code=` is accepted only when exactly one flow is pending.

### Bug fixes

- **Group session revival and summon exclusivity** (#270). A missing/expired external-MCP OAuth token could hold `LiveSession` creation behind the full ten-minute browser callback timeout, making an accepted group mention look silently stranded; OAuth authorization now continues single-flight in the background and the current session starts without that server, with a later session picking up the stored token. Queued group messages are revalidated asymmetrically at processing time so an active `/summon` takes ownership of pre-summon backlog, while `/dismiss` still cannot steal already-summoned work back; group cron/delegate work and attributed restart reasons follow the same exclusivity rule and queue on the summoned `dm:` session with its explicit group-reply reminder.

### Dependencies

- Bump `@anthropic-ai/claude-agent-sdk` 0.3.226 → 0.3.232.

## 0.8.13 (2026-08-07)

### Features

- **iMessage expressive-send effects and rich link previews** (#261). Effects are a property of a send, not a payload: `OutgoingMessage` gains a structured `effect` field surfaced through the `send_message` tool (direct mode only), never a text tag — channels that can't render effects ignore the field entirely, so no marker can leak into visible text on Telegram or the AppleScript fallback. `ImsgChannel.send` routes the first chunk through `send.rich` when a reply target and/or effect is present (continuation chunks stay plain: one effect per message, mirroring one thread reply per message); with the bridge down it falls back to a plain send plus a rate-limited re-probe. Effect names are validated in `ProactiveSendService` against the imsg `ExpressiveSendEffect` vocabulary — a typo'd name never fails the send, the text always delivers and the tool result names the rejected effect and the valid vocabulary (an error is only right when the caller can retry, and a fire-and-forget send can't retry without duplicating). A message part that is exactly one bare http(s) URL now sends as an Apple rich link preview via `send.rich`'s url mode, pre-gated on the bridge's `urlPreviewMessage`/`sendRichLinkAction` selectors. Rich-send fallbacks distinguish definite refusal from ambiguous failure: a JSON-RPC error *response* proves the child refused (nothing sent) and is safe to retry plainly, while a timeout or child death propagates instead — prefer a missing message over a duplicate. That also closes the pre-existing threaded-reply double-send window, which shares the branch.
- **iMessage native sticker sends** (#259). One `STICKER:` tag, discriminated by payload shape at the channel layer: a Telegram `file_id` keeps routing to Telegram's `sendSticker`; a local image path now routes to imsg's `send.sticker`, gated on `advanced_features` + the `send.sticker` RPC method + the `stickerSend` bridge selector. A sticker that can't send natively must not vanish — the sticker *is* the message, unlike an effect — so every definite non-native outcome (missing sticker surface, a `send.sticker` refusal over the 500KB/618px caps or an SMS chat) falls back to a plain image attachment; ambiguous failures (timeout, child death) propagate with no fallback. The degraded path calls `maybeReprobeCapabilities({ evenIfBridged: true })`, so a bridge that predates 0.13 heals when Messages relaunches. `attach_to` is deliberately left unwired — a single-valued tag can't name a target message, and overloading `replyTo` would silently turn "threaded reply" into the visually different "affixed to bubble" act. The workspace prompt documents both payload shapes and points at the curated collection in `~/.tomo/workspace/stickers/`.
- **`/usage` — Claude subscription limits in chat** (#255). Reports the current subscription's usage windows, driven off the `limits` array so per-model scoped caps are rendered rather than silently dropped: one line per limit grouped session-then-weekly, each with percent used, a countdown, and the local reset clock; the active limit is marked and elevated severity is flagged. Falls back to the legacy `five_hour`/`seven_day` windows when `limits` is absent. `src/agent/usage.ts` reads the OAuth token from the macOS Keychain (falling back to `~/.claude/.credentials.json` only when the `security` binary is absent — an operational Keychain failure surfaces an actionable message rather than a possibly-stale disk credential) and every failure mode resolves to a friendly one-liner; nothing throws. Auth-aware: API-key auth short-circuits without touching the Keychain, and gateway-routed models append a billing caveat. Owner + private-DM only, mirroring `/login`, so a group member can't trigger a Keychain read of the owner's plan. Requests carry a 10s `AbortSignal.timeout` tied to the response stream, and endpoint data is treated as untrusted throughout. Also a consistency pass: every slash-command response now leads with an emoji, with `⚠️` prefixing error/guard one-liners.
- **Native Claude Code plugin support via config** (#241). New top-level `plugins` array in `~/.tomo/config.json` — entries are local plugin paths or refs to plugins installed through the Claude Code CLI (`name` or `name@marketplace`), with an object form for `skipMcpDiscovery`. `src/agent/plugins.ts` resolves installed refs via `~/.claude/plugins/installed_plugins.json` (user scope preferred, unique bare-name matching), warns and skips instead of throwing, and flags component-less plugin dirs. Resolution happens at session spawn rather than config load, because installed paths are version-pinned and change on update; relative paths resolve against `~/.tomo` so the same config loads the same plugins regardless of where `tomo` was started.
- **Claude Opus 5 support** (#251). The `opus` / `opus-1m` aliases point at `claude-opus-5` / `claude-opus-5[1m]`, and it's surfaced in the `tomo init` model picker. Opus 4.8 remains usable as a direct model ID and keeps its display labels.

### Bug fixes

- **imsg capabilities are re-probed instead of frozen at startup** (#258, #260). `ImsgChannel` probed bridge capabilities exactly once in `start()`, so a boot-order race (daemon up before Messages.app relaunched with the bridge dylib — every macOS-update reboot or imsg upgrade) froze a degraded snapshot for the whole process lifetime, silently disabling typing indicators, read receipts, and threaded replies. Two mechanisms: a degraded first probe is retried quietly with backoff (≈2 min total) with the loud "run `imsg launch`" warning moved to *after* the schedule is exhausted, so a transient race resolves silently; and capability-gated sites kick a fire-and-forget re-probe when the cached answer is false, rate-limited to one probe per 30s and single-flight, so the gated call itself still skips exactly as before and the *next* call sees the fresh snapshot. The exhaustion warning distinguishes a probe that answered `advanced_features=false` (bridge not injected — run `imsg launch`) from one that kept throwing (capabilities unknown — check the imsg binary), since `imsg launch` would be the wrong remedy there. Nothing ever calls `imsg launch` automatically — it kills and relaunches Messages.app and stays a human decision.
- **Restart reasons route back to the initiating session** (#266). A `tomo restart --reason ...` run from one session's Bash tool delivered its reason to the blessed continuity session (first DM) on boot regardless of who initiated it — misrouting in both harmful directions: a DM-originated reason could leak private context into a group, and a group-originated one read to the DM session as its own pending work while the initiator silently lost its resume-context. Every live session's SDK child is now spawned with `TOMO_SESSION_KEY` (via `buildSdkEnv`), which the Bash tool inherits, so the restart CLI attributes its initiator with zero model cooperation; an explicit `--session <key>` flag overrides it. The reason file stays byte-identical plain text in both directions and attribution moves to a sidecar (`.restart-reason.session`) that only new binaries touch, so an old binary rolling back never delivers a JSON blob to the DM; the sidecar echoes the reason it was written for, so a stale one degrades to unattributed rather than attaching to a later reason. On boot: attributed → a continuity-style turn on the exact initiating session (groups included); attributed but unknown → dropped with a log line, never rerouted; unattributed (auto-update, human in a terminal, legacy file) → legacy blessed-session delivery, unchanged.
- **iMessage capability-gate refusals are legible** (#264). A closed gate was indistinguishable from a misreading gate. New `capabilityGateDiagnosis()` logs exactly what each gate read plus a verdict naming which link broke and its remedy — bridge down (`imsg launch`), CLI too old (upgrade imsg), selector *absent* (the running dylib predates the feature; quit Messages then `imsg launch`, since launch alone no-ops while the old resident bridge still answers ping), selector *false* (the OS removed the surface; nothing heals it). Wired at all three refusal points: sticker fallback, rich-link degrade (previously silent), and edit refusal. Signal provenance is documented on `ImsgCapabilities`: `rpc_methods` is a static list compiled into the CLI binary and proves nothing about the bridge inside Messages.app, while `imsg status` selectors are the live signal.
- **Sticker end-to-end fixes from the first real send/receive** (#265). A `send.sticker` refusal of the dylib's staging-hygiene family now logs a diagnosis naming the offending ancestor of the trusted staging root and the remedy — the RPC handler stages the file itself, so the refusal is never "we forgot to stage" but an ancestor failing the per-component walk (on the live machine, `~/Library/Messages` was `chmod 0777`). Inbound stickers are now described as stickers and resendable, mirroring Telegram's `describeSticker`, instead of being indistinguishable from photos. Inbound HEIC transcodes preserve transparency: stickers always convert to PNG and other HEICs probe `sips -g hasAlpha` and go PNG only when alpha is present — previously every HEIC was flattened to JPEG, which silently turned a transparent sticker background solid black.
- **Owner identity seeded at init so `/login` works from day one** (#247). `tomo init` collected the owner's Telegram user ID for the allowlist but never wrote an identities entry, so a fresh install had no configured owner and `/login` (and `/summon`) refused the only user of the bot with no hint how to fix it. Init now writes an owner identity binding that user ID, and `/login`'s refusal distinguishes the no-identities case and points at `tomo config` → Identities. The gate itself stays strict — `/login` mutates Claude credentials, so it never falls open the way `/model` and `/restore` do.

### Dependencies

- Bump `@anthropic-ai/claude-agent-sdk` 0.3.207 → 0.3.226 (#246, #253). Clears all 9 outstanding `npm audit` advisories, which were transitive through `@modelcontextprotocol/sdk` (`hono`, `ip-address`, `nanoid`, `postcss`).
- Bump `grammy` 1.44.0 → 1.45.1 (#244), `ink` 7.1.0 → 7.1.1 (#245), `react` 19.2.7 → 19.2.8 (#252), `minimatch` 10.2.5 → 10.2.6 (#256).
- Bump dev dependencies: `eslint` 10.7.0 → 10.8.1, `tsx` 4.23.0 → 4.23.11, `typescript-eslint` 8.63.0 → 8.66.0, `@types/react` 19.2.17 → 19.2.18 (#254).
- Bump `actions/setup-node` 6 → 7 (#242).
- Dependabot now ignores TypeScript 7.x (#248) — `typescript-eslint`'s peer range caps below it, so the grouped dev-dependencies PR failed `npm install` with `ERESOLVE` (#243). To be lifted and upgraded deliberately once upstream catches up.

## 0.8.12 (2026-07-12)

### Features

- **Prometheus metrics + activity log with Grafana stack** (#238). Two new `WatchBus` subscribers, gated by `config.metrics` (default off): a `prom-client` exporter on `127.0.0.1:9464` (turns, cost, per-session context, tool calls, cron, heartbeats, compactions) and an NDJSON activity log at `~/.tomo/logs/activity.ndjson` for Loki tailing (transcript text local-only, redactable via `metrics.includeMessageText=false`). `contrib/observability/` ships a docker-compose stack (Prometheus, Loki, Alloy, Grafana) with a provisioned Tomo dashboard.

### Dependencies

- Bump `@anthropic-ai/claude-agent-sdk` 0.3.201 → 0.3.207 (#237).
- Bump the dev-dependencies group (#236). The TypeScript ^6 → ^7 bump in that group was reverted — no `typescript-eslint` release yet supports TypeScript 7 (peer range caps at `<6.1.0`), so it broke `npm ci`.

## 0.8.11 (2026-07-09)

### Features

- **`imsg`-backed iMessage channel (BlueBubbles successor)** (#230, #231, #232, #234). A new `ImsgChannel` (`src/channels/imessage-imsg.ts`) implements the `Channel` surface over a single long-lived `imsg rpc` child (newline-delimited JSON-RPC 2.0 on stdio), selectable via `channels.imessage.provider: "imsg"` without touching the BlueBubbles channel. Inbound uses the `watch.subscribe` all-chat stream with attachments (local file paths), reply context, inbound tapbacks, slash commands, and group/DM mapping; outbound covers chunked sends, threaded replies via `send.rich` (with plain-send fallback), attachments, targeted tapbacks, typing indicators, mark-read, and unsend. Message edit is gated on the `imsg status --json` bridge selector probe, so on macOS 26 (where the edit selectors are gone OS-wide) the channel refuses cleanly instead of crashing Messages. The child restarts on crash with escalating backoff and resumes the watch from a persisted rowid cursor, and persistent GUID dedupe is shared with the BlueBubbles store so a provider cutover never re-dispatches messages. Session keys stay compatible — chat.db chat GUIDs are used verbatim (identical to what BlueBubbles reported), so existing session mappings survive. Inbound HEIC/HEIF attachments that `imsg` doesn't pre-convert are normalized to JPEG channel-side via macOS `sips` (by mime, `.heic`/`.heif` extension, or `ftyp` magic-byte sniff), read-only-safe (converts into a temp JPEG that is read then unlinked) and never dropped on conversion failure.
- **`tomo watch` — live mission-control TUI** (#229). An always-on terminal dashboard for watching what Tomo is doing, backed by a daemon-side event bus. `src/watch/bus.ts` is an in-process `WatchBus` singleton with a ring buffer, fed by emit hooks in `SessionStore.append` (inbound/outbound messages), `LiveSession` (tool start/end with durations, compact boundaries), `TurnRunner` (turn start/end with ingress source), the per-turn cost/context stats closure, `CronScheduler`, `ContinuityRunner`, and a pino tap (warn/error → "issue" events). `server.ts` serves NDJSON over `~/.tomo/watch.sock` (0600) — a snapshot on connect (vitals, cron next-runs, cost 24h/7d, feed backfill), then live relay; inbound "send" frames route chat into the dm session. The Ink/React TUI renders an activity feed (messages, tools with status + duration, turn summaries with cost + ctx%, cron, heartbeats), a pinned in-flight turn line, a vitals sidebar (context gauge, cost, next-up, last warn/error), a chat line, a raw-log-tail toggle, a group-traffic filter, scroll with follow mode, and a help overlay. Auto-reconnects with an offline header state and drops to a 15s idle render tick so it can stay open 24/7. The daemon never depends on clients.

### Bug fixes

- **Trailing `NO_REPLY` suppresses the whole block/turn** (#233). A reply whose final line(s) are a bare `NO_REPLY` is now suppressed entirely instead of delivering the stripped remainder — the agent narrates housekeeping turns and ends them with `NO_REPLY`, and that narration (sometimes including the literal `NO_REPLY` text) previously leaked to the channel (owner decision 2026-07-08: trailing `NO_REPLY` marks the whole response as not-for-the-channel). `agent/text-utils` gains `endsWithTrailingNoReply()` (`stripTrailingNoReply` stays exported for the watch TUI, which still shows the visible text); `TurnRunner.runSendTurn` (cron/continuity) silences the entire turn; imsg and BlueBubbles streaming drop a block whose trailing line is bare `NO_REPLY`; and Telegram streaming retracts the already-streamed message before the multi-part delivery path. Follow-up rounds close the Telegram over-4096 rollover gaps: finalized rollover head chunks are now deleted and un-recorded (new `forgetOwnMessage`) on every block-abandoning path (`finalFlush` suppression, multi-part re-delivery, `discardBlock`, `cancel`), suppression is judged on the full block buffer rather than the post-rollover slice, and attachment blocks (`MEDIA:`/`STICKER:`) are suppressed as a whole.
- **iMessage inbound reply context only for genuine threaded replies** (#234). Since the imsg cutover, nearly every inbound iMessage arrived tagged `[replying to: "..."]` even when the sender never used long-press → Reply, because the channel fell back to `reply_to_guid` — a chat.db column populated on almost every row (it points at the preceding message, usually our own last outbound; verified 186/186 inbound DM rows over 3 days carried it, vs. 7 with a genuine thread originator). The reply marker is now gated on `thread_originator_guid` only, with fallback to the recent-message ring and then a quote-less marker. Outbound threading and tapback handling are untouched.
- **imsg channel post-merge review fixes** (#232). `stop()` no longer leaves in-flight requests hanging forever — `killChild()` now rejects pending requests before nulling the child. A failed row with no numeric rowid (parsed as `0`) no longer wedges the cursor floor permanently — it is logged and skipped. A write parked on `drain` now settles when its response arrives (the response proves the child consumed the line), so a healthy answering child is never killed by the drain backstop. A temp JPEG from a failed HEIC conversion is unlinked instead of leaking.

## 0.8.10 (2026-07-06)

### Features

- **Edit and unsend Tomo's own sent messages** (#226). New `edit_message` and `unsend_message` MCP tools let the agent fix or retract a message it already delivered — the most recent own message by default, or a specific one via case-insensitive substring match over its own recent messages (matching `fromMe` messages only). `Channel` gains optional `editMessage`/`unsendMessage` capabilities: Telegram uses `editMessageText` (with a Markdown→plain fallback mirroring `send()`) and `deleteMessage`, with friendly errors for Telegram's ~48h delete window; iMessage/BlueBubbles uses the Private API `/message/:guid/edit` and `/unsend` (macOS Ventura+; Apple's 15-min edit and 2-min unsend windows), updating or dropping the cached ring text on success. Telegram now also tracks a per-chat recent-message window, so `react_to_message`'s `match` and `send_message`'s `reply_to` are no longer iMessage-only. Captioned Telegram photos are now recorded into that window too (via `editMessageCaption` fallback), so a no-match `unsend` right after one no longer deletes the previous text message instead of the photo.
- **iMessage reply threading and targeted tapbacks** (#221). Inbound threaded replies (`threadOriginatorGuid`) surface as a `[replying to: "..."]` marker quoting the first 60 chars of the original, degrading to a quote-less marker when the lookup fails and never blocking delivery. Outbound honors `OutgoingMessage.replyTo` on the Private API (`selectedMessageGuid` + `partIndex`, first chunk only). A bounded per-chat window (50) of recent message GUIDs + text is tracked from the webhook for both inbound and `isFromMe` rows and exposed via the new optional `Channel.recentMessages`.
- **`/pause` and `/resume` for group chats** (#224). Any group member can `/pause` to temporarily silence Tomo in that group — inbound group messages are dropped at receipt, never reaching a session, the batcher, or the transcript, so nothing from the paused period enters context. `/resume` lifts it. Both are group-only and need no owner identity. The new `PauseStore` persists paused keys at `~/.tomo/data/pauses.json` (surviving restarts); `enqueueMessage` gates before routing resolution (so a paused group can't extend a summon's activity clock) and re-checks per item at batch-processing time. Registered in Telegram (command list + bot menu) and iMessage, and surfaced in `/status`.
- **`tomo status` dashboard and config health** (#225). `tomo status` is upgraded from a bare PID/uptime line into a dashboard: daemon state, config validation issues, configured channels, active sessions (context %, queries, cost), and upcoming scheduled-task runs. `tomo config` now shows daemon state at the top and surfaces `configIssues` inline — previously a broken config value silently blocked startup with no hint in the very UI meant to repair it. Pid-file liveness helpers are extracted into `src/cli/status-info.ts`, shared by the daemon, status command, and config menu.
- **Scheduled-tasks view and cron enable/disable** (#225). The interactive `tomo config` menu gains a "Scheduled tasks" section showing each cron job's status (enabled/disabled, schedule, next/last run, failure state) with enable, disable, and remove actions. New `CronStore.setEnabled()` keeps a disabled job but stops it running; enabling recomputes the next run and re-arms an expired one-shot with its retry budget reset. Same actions exposed via `tomo cron enable/disable <id>`. Shared schedule/relative-time formatters moved to `src/cron/format.ts` so the CLI and config view render consistently (`every 2h` instead of `every 120m`; relative next-run times).

### Bug fixes

- **Send-turn responses ending in `NO_REPLY` no longer drop earlier text** (#223). Non-streaming turns (cron jobs, delegate `send_message` notifications, continuity heartbeats) run through `TurnRunner.runSendTurn`, which sees the whole turn's text blocks joined into one string. A blanket `includes("NO_REPLY")` check silently dropped the entire response when a turn emitted real user-facing text mid-turn and only ended with `NO_REPLY` (e.g. text → tool_use → `NO_REPLY`). New `stripTrailingNoReply()` peels only a bare trailing `NO_REPLY` block, so earlier substantive text still ships while a response whose only content is `NO_REPLY` stays silent and housekeeping turns are unaffected.
- **Slash commands gated on the channel allowlist; `/restore` and `/model` owner-gated** (#220). Slash commands went straight from `Channel.onCommand` into the handler without the allowlist check that inbound messages get; `handle()` now checks `router.isAllowed()` first and drops disallowed chats silently. `/restore` and `/model` additionally require the sender to own a configured identity (unchanged when no identities are configured). `persistModelOverride`'s config read/parse/write is hardened so a malformed `config.json` yields an error reply instead of an unhandled exception, updating in-memory state only after a successful write.
- **iMessage command dispatch normalizes the sender address** (#220). The BlueBubbles webhook's slash-command path passed the raw handle address as `senderId` while the message path normalized it, so a formatted address like `+1 (555) 123-4567` failed owner checks against a configured `+15551234567`. Command dispatch now derives `senderId` exactly like the message path.
- **`tomo status` uptime and disabled-cron next-run** (#225). `getDaemonStatus` could report a slightly negative uptime when the pid file's mtime landed a fraction ahead of `Date.now()` (filesystem timestamp granularity) — now clamped to zero. Disabling a cron job left its `nextRunAt` in place, so views showed a "next run" for a job that would never fire — now cleared on disable.

## 0.8.9 (2026-07-05)

### Features

- **People registry for group-chat identity recognition** (#214). Group senders used to be just a display-name string, so a friend using a nickname, renaming their Telegram profile, or appearing under a different name per channel looked like a different person — and recognition relied on the model remembering to consult a freeform memory file. Identity resolution is now deterministic and harness-side, keyed on stable channel ids, with a structured people registry as the source of truth: `IncomingMessage` carries a `senderId` (Telegram user id, normalized iMessage address); `SessionEntry.participantIds` tracks display names seen per id so profile renames stay one human; person records live at `memory/people/*.md` (DM-only ones under `memory/private/people/`) with name/aliases/handles frontmatter and automatic handle binding the first time a sender's name unambiguously matches an unbound record. Group transcript lines annotate the canonical identity inline (`kw 🚀 (Kevin Wang): ...`), the group prompt lists resolved participants, and every prompt gets a PEOPLE roster. New `list_people` / `upsert_person` MCP tools let the agent maintain the registry. Private records never enter group flows: the transcript annotation and auto-bind candidates are unconditionally public-scoped (so a group-only DM record can't leak or double-bind), and display-name matching falls back to comparing with emoji/symbols/punctuation stripped so a decorated profile name (`kw 🚀`) still binds against alias `kw`.
- **Prune-first context nudge** (#211). The compaction ladder now attempts a cheaper tool-result prune before escalating to a daily rollup nudge. The post-turn context-pressure check is skipped on the turn that actually compacted, whose in-memory reading is measured against the pre-rewrite context and always reads stale-high — that stale reading used to escalate every prune straight into a daily rollup, defeating prune-first; the next turn's fresh reading on the reloaded session now drives both escalation and latch reset.
- **Satellite iMessage tagging** (18d0e37). Inbound iMessage text from an iMessageLite / satellite source (detected from the BlueBubbles message or handle service) is prefixed with a short satellite marker, with dispatch-level coverage for serialized handle service and empty satellite rows.

### Bug fixes

- **Proactive and system-turn deliveries are now recorded and correctly routed** (#204, #205, #206). A batch of `#203` fixes closing the "delivered but unrecallable / misrouted" gaps for messages the assistant sends outside a user turn. Continuity heartbeats, cron-window deliveries made during heartbeat turns, and the post-restart status notice were never written to the transcript (the continuity `TurnSpec` used `transcript: "never"`, now `"on-delivery"`; the opt-out policy was removed so no turn type can skip recording again). `send_message` calls targeting a raw `<channel>:<chatId>` key that matches an identity's bound DM chat now canonicalize to that identity's `dm:` session for transcript/recall purposes while delivery stays pinned to the named channel, and `delegateToSession` threads the raw reply-target through as a delivery override so a pinned `telegram:<chatId>` delegate no longer gets re-routed to a different channel by the dm session's reply policy. `normalizeSendTarget` now matches iMessage chats by the identifier extracted from the chat GUID (shared with the router via `extractImessageIdentifier` in `sessions/keys.ts`), with group keys excluded.
- **LCM compaction range safety anchors** (#209). Compaction ranges are now guarded with UUID anchors so a range resolved against one view of the session file can't silently compact the wrong events if the file shifted underneath it.
- **LCM nudge: empty daily nudges and CJK token estimates** (#207). Empty daily nudges are handled instead of firing a no-op housekeeping turn, and the token estimate accounts for CJK text; a redundant nudge session lookup was also removed.
- **LCM cleanup: dead code, TOCTOU trigger race, and timezone parsing** (#206). Removed a duplicated `removeSet` loop in `compact.ts` whose comment described behavior that didn't exist, plus unused `countRawTailToday`/`convIndices` helpers; `checkAndClearCompactTrigger` now unlinks directly and treats `ENOENT` as "no trigger" so a concurrent clear can't throw out of post-turn bookkeeping; and `resolveTimeRange` parses date-only boundaries (`YYYY-MM-DD`) as the full local day instead of UTC midnight, so `--to-time 2026-03-28` now includes that whole day.

### Other

- **Unified `<tomo-event>` envelope for harness-composed messages** (#212). The two ad-hoc conventions for harness-injected user-turn messages (bare `System: ...` prefix and bracketed `[System: ...]` note) are replaced with a single XML envelope built by one helper, migrating all 13 producers (heartbeat, restart, cron, lcm-rollup, context-nudges, summon/dismiss, audience, errors, direct-send, delegate) with body content unchanged; consumers stay tolerant of the legacy forms so old transcripts never need migration. The envelope escapes any body-injected `</tomo-event>` closer with a minimal injective scheme so user-controlled cron/direct-send/delegate text round-trips exactly and can't close the envelope early. Also adds a conservative outbound scaffold-leak filter that truncates assistant messages at an anchored `end_of_dialog` sentinel or a paragraph-initial narrator leak before delivery.
- **LCM rollup quality feedback** (#210). Improved the quality signal surfaced by the daily-rollup path so low-value rollups are easier to spot.
- Bump `@anthropic-ai/claude-agent-sdk` from 0.3.195 to 0.3.201 (#217).
- Bump `@clack/prompts` from 1.6.0 to 1.7.0 (#216).
- Bump dev dependencies: `tsx` 4.22.4 → 4.23.0 and `typescript-eslint` 8.62.0 → 8.62.1 (#215).

## 0.8.8 (2026-07-03)

### Features

- **Conversation recall** (#200). New tomo-internal `recall_conversation` MCP tool gives the agent case-insensitive substring search over its own transcript — including messages compacted out of the SDK context window or moved into monthly rotation archives — with optional ISO 8601 time bounds and a paging hint when results hit the limit. Search is scoped to the calling session's key, so a group session can only recall that group's history (never DMs); results are oldest-first with timestamps, roles, sender names, and seq numbers, and per-message excerpts are capped at 400 chars. The harness prompt now tells the agent to search history before claiming it doesn't remember. `SessionStore.searchTranscript` also skips records without string content instead of aborting the whole search.

### Bug fixes

- **Lazy retirement of prompt-stale sessions** (#201). A system-prompt hash change used to retire every live session at once — idle sessions closed and busy ones yanked from the map, so the next message for a busy key spawned a parallel fresh session (losing the steering target) while every key paid an MCP reconnect and full prompt-cache rewrite simultaneously; frequent workspace memory-file writes made this a recurring mass-churn event. A hash change now only *marks* sessions prompt-stale: a stale session keeps serving its in-flight (and queued/steered) work and retires at its next idle boundary, so conversations are never interrupted and reconnects stagger with each key's natural traffic. The hash is checked on every `getOrCreateLiveSession` call, so even a lone long-lived session notices workspace changes by its next idle turn.
- **1h prompt-cache TTL under api-key/gateway auth** (#201). Sets `ENABLE_PROMPT_CACHING_1H=1` in the SDK child env unless the user already sets it. Without the flag, api-key and LiteLLM-gateway sessions silently fell back to the 5-minute cache TTL and re-paid full cache writes on their large system-prompt prefixes; it is a no-op on subscription auth.
- **Telegram polling backoff and cron one-shot retries** (#199). Telegram polling restarts now back off exponentially (3s doubling to a 5-minute cap) instead of hot-looping every 3s on a permanent failure like a revoked token; a run that stays up past 60s counts as healthy and re-arms the backoff, and the pending restart timer is cleared on `stop()`. Failed one-shot (`at`) cron jobs now get two delayed retries (5 minutes apart) before being disabled instead of being silently disabled on the first error — the reminder is the deliverable. Recurring jobs are unchanged.
- **Codebase-review bug fixes** (#198). Group activation via secret no longer creates an allowlist on an open channel (which locked out every other chat, including the owner's DM), and a newly created in-memory allowlist is seeded with identity-bound chatIds. The continuity heartbeat fallback resolves private targets only, so a heartbeat can never run on a group session and leak its prompt there. `LiveSessionManager`'s reset-and-retry matches session-lifecycle errors narrowly instead of any error mentioning "session", preventing full-turn re-runs (and duplicated side effects) on unrelated failures. Telegram mention detection uses word-boundary matching so `@mybot` no longer matches inside `@mybot_backup`. Telegram photo sends with captions over the 1024-char limit ship the photo captionless and deliver the text as its own chunked message instead of failing the whole send.

## 0.8.7 (2026-07-01)

### Features

- **Sonnet 5 default and flexible model IDs** (#186). `sonnet` now resolves to `claude-sonnet-5`, the fallback/default model and `sonnet-1m` resolve to `claude-sonnet-5[1m]`, and `/model` accepts future direct model IDs without requiring a code update while keeping LiteLLM `provider/model` names behind the gateway guard.
- **Chat cost command** (#186). `/cost` reports the current session's 1d, 7d, and 1mo cost totals from daemon usage logs.
- **Transcript tail-loading, monthly rotation, and recent-first search** (#190). Session transcripts are no longer loaded whole into memory and kept forever — `get()` reads only the last N messages (backwards, in chunks) and the in-memory cache trims back to the tail as it grows. Active transcripts over 2MB rotate prior-month messages into monthly archive files with a crash-safe, seq-based idempotence guard, and sequence numbers continue from the archives even when rotation empties the active file. `searchTranscript()` now streams newest-first with early exit and returns the most *recent* matches when the limit truncates (it previously returned the oldest), continuing into archives as needed. `/status` turn counts and session `createdAt` survive rotation.
- **Config validation with zod** (#196). The hand-rolled config coercion was replaced with zod schemas. Invalid values still fall back to their defaults so `tomo init`/`tomo config` can repair a broken file, but every fallback is now reported with the field, offending value, and default used — and `tomo start` refuses to launch the daemon with the aggregated list instead of running on silently-wrong settings. Malformed `config.json`, invalid identity entries, and boolean-like strings (`"true"`/`"1"`/`"yes"`) are all handled consistently; an omitted `lcm.nudgeResetPct` is derived from `nudgeAtPct` as before.

### Bug fixes

- **Session cost totals survive restarts** (#188). `totalCostUsd` was assigned the SDK's cumulative per-process cost instead of accumulating the per-turn delta, so it silently reset to the current process's spend on every daemon restart or session reload.
- **Single compact-nudge path with hysteresis** (#189). Two overlapping nudge paths both evaluated the same turn's context stats — at ≥80% usage both fired, queueing two token-costing housekeeping turns back-to-back. There is now one nudge check per completed turn with two escalation levels (daily rollup at `nudgeAtPct`, compact skill at 80%) behind a shared hysteresis latch that re-arms below `nudgeResetPct`. The check also now covers the session-error retry path and unowned SDK background turns, which previously skipped post-turn bookkeeping entirely.
- **Cron scheduler correctness** (#187). A per-job in-flight guard replaces the whole-tick lock, so one long-running job no longer delays every other due job; due jobs dispatch concurrently and `every` schedules advance from the scheduled due time instead of run completion (no more cadence drift, no burst-firing after downtime). Cron run status now reflects reality — turns that complete with agent-level errors are recorded as `error` instead of always `ok`.
- **Performance and robustness fixes from a codebase review** (#187). The session registry is no longer re-read and re-parsed from disk on nearly every store operation (~16x faster via an mtime+size check), and a system-prompt change no longer closes busy sessions mid-turn — they retire from the map immediately but close only once idle, instead of tripping a reset-and-retry that repeated the turn's side effects. Prompt-retired busy sessions are also now closed on daemon shutdown.
- **Cleanup batch: small correctness fixes** (#191). Prompt-change detection hashes with SHA-256 instead of a collision-prone 32-bit rolling hash; Telegram mention-stripping escapes the bot username before building a RegExp and download-failure logs redact the bot token; numeric env vars fall back to defaults on garbage input instead of propagating `NaN`; `CronStore.add()` reloads from disk before mutating so a stale in-memory snapshot can't resurrect jobs removed by another process.

### Other

- Internal refactor: the monolithic `Agent` class was split into focused subsystems — inbound queues and delivery primitives (#192), a spec-driven `TurnRunner` unifying the user/cron/continuity turn pipelines (#193), and `LiveSessionManager` + `ProactiveSendService` owning session lifecycle and proactive sends (#194).
- Split the 3,634-line agent integration test suite into nine feature-scoped suites with a shared harness (#195).

## 0.8.6 (2026-06-30)

### Features

- **Newline message-splitting** (#179). A line break in the assistant's reply is now delivered as a *separate* chat message, mimicking natural texting rhythm instead of one block with linebreaks. Blank lines act as separators (never producing empty messages) and each piece is trimmed. The literal token `[[NL]]` is an escape hatch — it is restored to a real newline and does **not** split there, so code snippets and lists that must stay together can live in one message. Caption text before a `MEDIA:` tag still rides with the media as one captioned message. Wired through both iMessage (buffer-on-finish) and Telegram (streaming edit-in-place), documented in the default `AGENT.md` and the system skill, and extended to the direct/system delivery paths (#182).
- **Deliver SDK background task replies** (#178). Unowned SDK turns — output produced by the SDK with no waiting request, such as background task replies — are now routed to a default delivery target instead of being silently dropped.

### Bug fixes

- **Activity-based live-session timeout** (#181). The session timeout now refreshes on SDK activity rather than firing on a fixed per-turn deadline, so long-but-legitimate turns are no longer killed prematurely.
- **Literal newline token splitting** (#183). Fixes `[[NL]]` token handling in the outbound message splitter.

### Other

- **More readable `tomo logs`** (#184). `tomo logs -f` now renders sender, group title, outbound session key, and subagent name inline instead of burying them in raw JSON. Subagent tool calls are attributed to the spawning agent (`agent=<subagent_type>`, including nested spawns), and tool-result errors get an `[ERR]` prefix.
- Remove dead `AGENT`/`SOUL`/`IDENTITY` templates under `src/workspace` (#180).

## 0.8.5 (2026-06-26)

### Features

- **API key authentication config** (#158). Adds explicit API-key auth configuration and prevents the Anthropic API key from leaking to custom gateways/base URLs.
- **Claude login from the owner DM** (#165). The owner can authenticate Claude directly through a DM command instead of the CLI only, with clearer messaging when login verification fails.
- **Custom workspace for SDK sessions** (#175). SDK sessions now honor a configured custom workspace path. Runtime path resolution was consolidated into a new `runtime-paths` module.

### Bug fixes

- **iMessage inbound webhook dedupe is now persisted** (#163). Webhook dedupe state survives daemon restarts instead of living only in memory, so restarts no longer risk re-processing recently seen messages.
- **Direct-send note attribution** (#148). Summoned-group direct sends are attributed to the correct caller, attribution is caller-aware, and pending notes are capped.
- **Suppress group LCM output** (#164). Lifecycle-management chatter no longer leaks into group chats.

### Other

- Test against Node 26 in CI and align Node typings (#171).
- Extract `backup-workspace` out of the backup command.
- Bump `@anthropic-ai/claude-agent-sdk` `0.3.181` → `0.3.195` (#173, #169, #176).
- Bump `grammy` `1.44.0` (#168), `@clack/prompts` `1.6.0` (#170), `eslint` `10.6.0`, `actions/checkout` v7 (#166), and the dev-dependencies group (#174).

## 0.8.4 (2026-06-19)

### Features

- **`/summon` — pull your main session into a group chat.** A configured identity's owner can `/summon` in an allowlisted group so the group's messages run on their unified `dm:` session (full personal context) until `/dismiss` or after `summonExpiryMinutes` of group inactivity (default 60; `0` disables, `TOMO_SUMMON_EXPIRY_MINUTES` to override). Turn output stays in the owner's private DM — group-facing replies require an explicit `send_message` direct-mode call — so private context never auto-posts to the group. Summon state is persisted across daemon restarts, lapses lazily, and an audience-switch note is injected when a `dm:` session's inbound audience flips between private DM and a summoned group.
- **Configurable continuity heartbeat.** The continuity heartbeat interval is no longer hardcoded and can be tuned via config.
- **`pet_status` chat command** (#157). Surface the virtual pet's current state directly from chat.
- **Message steering on by default** (#150). `steering` now defaults to on (`TOMO_STEERING=false` to opt out), and direct sends were cleaned up alongside it.

### Bug fixes

- **`/summon` no longer emits a spurious "expired — handed back" notice on re-summon** (#160). The "already summoned?" guard read (also used by `/status` and `/dismiss`) lazily expired a lapsed summon and fired the group-facing handback notice, so re-summoning a group whose previous summon had gone stale posted a contradictory pair of messages. The handback notice now fires only on the real group-message routing path; guard reads still clear the `dm:` session's stale "summoned" context, but silently.
- **Session timeout recovery and LCM typing fixes** (#155).
- **iMessage typing-indicator lifecycle fix** (#154). The typing indicator is started and cleared correctly across the message lifecycle.
- **`send_message` MEDIA/STICKER tag parsing in direct mode** (#147). Attachment tags are now parsed in direct sends, with regression coverage.
- **Virtual pet hunger pacing tuned** (#149).

### Other

- Internal refactor: extracted inbound batching and chat-command handling out of the `Agent` class (#145).
- Bump `@anthropic-ai/claude-agent-sdk` `0.3.168` → `0.3.177` → `0.3.181` (#159, #153).
- Bump dev-dependencies group (#152).

## 0.8.3 (2026-06-11)

### Features

- **Message steering** (#142). New optional `steering` config (`TOMO_STEERING=false` to opt out, default on) lets user messages that arrive during an in-flight tool-using turn bypass the per-session queue and inject at the next tool-call boundary. If the current turn has no boundary left, the message runs as the next follow-up turn. Cron, continuity, and other system-originated turns continue to queue normally.

### Bug fixes

- **Six high-severity fixes from a codebase review** (#140):
  - Fresh installs no longer crash on every CLI command (including `tomo init` and `--help`) when no channel is configured — channel validation moved from config load to daemon startup, and `tomo start` now validates before spawning the background child instead of printing "started" while the daemon silently dies.
  - The iMessage webhook server binds `127.0.0.1` instead of all interfaces and caps request bodies at 1 MB; the webhook is also registered as the literal `127.0.0.1` (BlueBubbles could resolve `localhost` to `::1` and get connection refused), with stale `localhost`-form registrations from earlier versions cleaned up on upgrade.
  - The cron scheduler no longer re-fires a due job on every 30s poll while a long agent run is still in flight (re-entrancy guard on `tick()`), and tick errors are caught instead of becoming unhandled rejections.
  - Telegram streaming no longer silently drops content when a send/edit fails: progress is only advanced on success, the final flush retries with backoff, blocks over 4096 chars roll over into a new message, and `send()` chunks long text like iMessage does.
  - `tomo backup restore` no longer deletes the preserved `.claude` directory along with the workspace tree; the backup's custom skills are merged in without overwriting live ones.
  - The LCM compact nudge goes through the per-session queue instead of a fire-and-forget run that could overlap the next user message.
- **Multi-process race and atomic-write fixes** (#141). The daemon and CLI commands (`tomo cron add`, `tomo sessions clear`, `tomo config`, `tomo lcm prune-tools`) mutate the same files and could clobber each other:
  - `SessionStore` registry mutators and list APIs reload from disk before acting, so CLI-side changes are no longer reverted by the daemon's next stale save.
  - `CronStore.markRun`/`remove` reload before saving, so a job added while the daemon executes another job is no longer silently deleted.
  - The MCP OAuth token store, pet store, and SDK session repair now write atomically (temp + rename) — a crash mid-write previously left truncated JSON that could permanently discard every MCP server's refresh token.
  - `tomo lcm prune-tools` rewrites the live SDK JSONL with the same concurrent-append-safe machinery as compaction, instead of a plain read/write that could truncate events the SDK was appending mid-prune.

### Other

- Raise minimum Node version to 22.12 (#139).
- Internal cleanup: extracted shared `fs-utils`, `jsonl`, and session-key helpers (#138).
- Bump `commander` 14.0.3 → 15.0.0 (#123).

## 0.8.2 (2026-06-08)

### Features

- **Continuity script hook.** `~/.tomo/config.json` can now include an optional `continuityScript` path or object. On each scheduled heartbeat or manual `tomo continuity` trigger, Tomo runs the script once, captures bounded stdout/stderr or failure status, and appends that result to the normal continuity prompt before sending it to the agent.
- **LCM global fresh tail (cross-day warm context)** (#131). New `config.lcm.globalFreshTail` (default `false` — today-only behavior unchanged when unset) makes the LCM fresh tail a session-global boundary instead of a per-day one. With it on, the newest N conversational turns stay warm across day boundaries, so a new day starts with warm raw context instead of cold-starting from summaries. Implemented without a `compactSession` API change: daily rollups simply stop their range before the warm suffix, and `findDuePromotions` defers promotion of raw inside the window (serving as both the no-re-nudge guard and the GC trigger). A new `isWarmTailCandidate` classifier counts real user/assistant turns while ignoring cron/heartbeat injections and tool machinery; retention is positional so interleaved events and the `parentUuid` chain are preserved.

## 0.8.1 (2026-06-07)

### Bug fixes

- **Coalesce split iMessage fragments into one turn** (#130). iMessage/BlueBubbles often delivers a single user message as several rapid-fire webhooks (text, then a link preview, then an attachment), which Tomo processed as separate turns. Inbound iMessage bursts now wait a short settle window so the fragments coalesce into a single user turn before the agent runs. The window is configurable via `imessage.inboundSettleMs` / `IMESSAGE_INBOUND_SETTLE_MS` (default 1500ms) with a per-burst ceiling via `imessage.inboundMaxSettleMs` / `IMESSAGE_INBOUND_MAX_SETTLE_MS` (default 5000ms) so a continuously extended burst can't be delayed indefinitely.

### Other

- Bump `@anthropic-ai/claude-agent-sdk` 0.3.161 → 0.3.168 (#133).
- Bump `@clack/prompts` 1.5.0 → 1.5.1 (#134).
- Bump dev-dependencies group (#132): `@types/node` 25.9.1 → 25.9.2, `@vitest/coverage-v8` & `vitest` 4.1.7 → 4.1.8, `tsx` 4.22.3 → 4.22.4, `typescript-eslint` 8.60.0 → 8.60.1.

## 0.8.0 (2026-06-03)

### Features

- **LiteLLM gateway / ChatGPT subscription support (experimental)** (#126). Tomo still runs on the Claude Agent SDK, but `~/.tomo/config.json` can now include a `litellm` gateway block that points the SDK child process at a LiteLLM proxy via `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` (also overridable with `TOMO_LITELLM_BASE_URL` / `_API_KEY` / `_MODE`), keeping sessions, memory, workspace, MCP tools, and LCM behavior intact while routing model calls through the proxy. The config UI offers a first-class `chatgpt-subscription` mode (including the tested `chatgpt/gpt-5.5` path and proxy setup notes) alongside generic Anthropic-compatible proxies; `/model` and the config model pickers accept LiteLLM `provider/model` names, and `/status` shows the active gateway/mode. Model alias/label resolution moved out of the `Agent` class into `src/models.ts`, and `buildSdkEnv` (`src/agent/sdk-options.ts`) composes the gateway env cleanly with the existing `DISABLE_AUTO_COMPACT` logic. Two guardrails added during review: `/model` and the config picker reject/hide LiteLLM model names when no gateway is configured (instead of silently saving an override the real Anthropic endpoint can't serve), and routing is mode-aware — an `anthropic-compatible` proxy routes all models, while a `chatgpt-subscription` proxy routes only LiteLLM models and lets Claude-model sessions hit Anthropic directly (so an Opus request never lands on a chatgpt-only proxy). The current model is now surfaced in the system prompt.
- **Virtual pet growth & recovery overhaul** (#124). New pets now start as an actual `egg` and hatch into `baby` after 1 day, with slower stage gates: `child` at 7 days, `teen` at 14, `adult` at 30, and `elder` at 180. Care quality — not just raw affection — now drives evolution: a new `care_mistakes` counter feeds an `effective_affection` value (each mistake subtracts 5) that evolution checks read instead of raw affection. When health reaches 0 the pet enters a recovery state where it can't play or evolve until health climbs back to 25, and feed-based affection farming is blocked (food above 90 hunger is ignored; feed affection is only granted below 50 hunger and never while recovering). Recovery state, effective affection, and care mistakes are surfaced through `pet_status`.

### Bug fixes

- **Prevent thinking blocks from leaking to chat** (#128). Tomo streamed SDK partial text deltas straight to Telegram/iMessage without tracking the active content-block type, so thinking-like content exposed through a text-shaped partial event could be delivered as public reply text. Adaptive-thinking display is now omitted for supported Claude Sonnet/Opus models, live streaming forwards only deltas from active `text` blocks, and final assistant aggregation accepts explicit `type: "text"` blocks only — with regression coverage for thinking-block leakage.

### Other

- Bump `@anthropic-ai/claude-agent-sdk` 0.3.150 → 0.3.158 → 0.3.161 (#121, #127).
- Bump `@clack/prompts` 1.4.0 → 1.5.0 (#122).
- npm audit lockfile remediation: resolve vulnerable transitive packages to patched versions (#125).
- Bump dev-dependencies group (#120): `eslint` 10.4.0 → 10.4.1, `typescript-eslint` 8.59.4 → 8.60.0.

## 0.7.0 (2026-05-29)

### Features

- **External MCP server support with harness-managed OAuth** (#114, #115). Users can declare additional MCP servers in `~/.tomo/config.json` under `mcpServers` (also accepted as `mcp.servers`) for stdio, HTTP, streamable HTTP, and SSE transports; optional `mcpAllowedTools` restricts the surface, otherwise all configured tools are exposed. For OAuth-protected remotes (GitHub Copilot MCP, Robinhood MCP, etc.), a per-server `oauth` block drives authorization-code + PKCE with dynamic client registration and a localhost callback; the harness refreshes near-expiry tokens and injects `Authorization: Bearer …` into HTTP/SSE headers at session-build time. Tokens live in `~/.tomo/workspace/secrets/mcp-oauth.json` (mode `0600`), kept separate from `keychain.json` so keychain rewrites don't wipe MCP auth, and never reach the agent. Auth failures are isolated per server — a broken server is omitted with a one-line notice and the session still starts. Discovery follows RFC 9728 `WWW-Authenticate` challenges with a `/.well-known/oauth-protected-resource/...` fallback for POST-only endpoints like Robinhood MCP. The bundled `tomo-system` skill now tells the agent that user-configured tools appear as `mcp__<server>__<tool>` and that it should never ask users for tokens.
- **1M context model options** (#116). New `/model` aliases `sonnet-1m` and `opus-1m` map to `claude-sonnet-4-6[1m]` and `claude-opus-4-8[1m]`. `claude-sonnet-4-6[1m]` is now the default for new/fallback configs. Init/config UI labels, the Telegram command description, README, and `tomo-system/CONFIG.md` are updated to match.

## 0.6.1 (2026-05-28)

### Other

- Default Opus model upgraded from Claude Opus 4.7 to Claude Opus 4.8 (#113).

## 0.6.0 (2026-05-26)

### Features

- **Virtual pet companion** (#111). Tomo now has a pet that lives at `~/.tomo/data/pet.json`. Five MCP tools on `tomo-internal` let the agent interact with it: `pet_hatch` (name and species), `pet_status` (current mood and stats), `pet_feed`, `pet_play`, and `pet_sleep`. Stats (hunger, happiness, energy, health) decay over time; affection accumulates through interactions and drives evolution through six stages: egg → baby → child → teen → adult → elder. A `PetScheduler` runs inside the tomo process and ticks every hour — no cron job setup required. When the pet needs attention (hunger, health drop, evolution), the scheduler sends a notification via `agent.sendNotification()`.

## 0.5.11 (2026-05-26)

### Bug fixes

- **Normalize iMessage image orientation** (#108). iMessage/BlueBubbles forwards iPhone photos with their original EXIF Orientation tag intact and no pixel rotation baked in, so a portrait shot the model saw sideways via iMessage (Telegram's client pre-rotates and strips the tag, so it looked fine there). Normalization is now a buffer-level operation (`normalizeJpegBuffer` in `src/channels/imageStore.ts`) that runs in the channel layer before *either* base64-encoding for the model or writing to disk, so both paths get the same upright bytes — including when image persistence is off. A portrait iPhone shot (orientation=6, 5712×4284 landscape pixels) now becomes a 4284×5712 portrait buffer with orientation=1.
- **Clear iMessage typing indicator on silent replies** (#105). When a turn resolves to a silent reply (`NO_REPLY`), the iMessage typing indicator is now cleared instead of being left running, so Tomo no longer appears stuck "typing".
- **Prevent duplicate `dm:` sessions from `send_message` target casing** (#109). `resolveSendTarget` built DM session keys as `dm:<name>` while the inbound router builds them as `dm:<name.toLowerCase()>`, so a caller using an identity name verbatim from config (e.g. target `"Shuai"`) spawned a parallel `dm:Shuai` session that never received inbound messages. A new side-effect-free `normalizeSendTarget` helper (`src/agent/send-target.ts`) lowercases both identity-name lookups and `dm:` keys, leaving channel keys unchanged.

### Other

- Bump `@anthropic-ai/claude-agent-sdk` 0.3.143 → 0.3.150 (#107).
- Bump dev dependencies group (#106): `@types/node` 25.8.0 → 25.9.1, `tsx` 4.22.0 → 4.22.3, `typescript-eslint` 8.59.3 → 8.59.4, `vitest` & `@vitest/coverage-v8` 4.1.6 → 4.1.7.

## 0.5.10 (2026-05-17)

### Other

- Bump `@anthropic-ai/claude-agent-sdk` 0.2.139 → 0.3.143 (#102). The 0.3.142 release renamed the `TodoWrite` tool to `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`; the allowlist in `src/agent/sdk-options.ts` and the corresponding permissions test fixture were updated to match (#103).
- Bump `grammy` 1.42.0 → 1.43.0 (#101).
- Bump dev dependencies group (#100): `@types/node` 25.7.0 → 25.8.0, `eslint` 10.3.0 → 10.4.0, `tsx` 4.21.0 → 4.22.0.

## 0.5.9 (2026-05-13)

### Features

- **Persistent per-session model switching.** `/model <name>` now writes the selected model into `sessionModelOverrides` in `~/.tomo/config.json`, so the choice survives daemon restarts. The current live SDK process is still closed immediately so the next turn uses the selected model. `/model` now accepts the short aliases (`sonnet`, `opus`, `haiku`) or their known full model IDs, and rejects unknown names instead of persisting typos. The old `sonnet-1m` / `opus-1m` aliases were removed from chat commands and the config TUI.
- **Chat restore for bad config edits.** New `/restore` command restores `~/.tomo/config.json` from `~/.tomo/config.json.bak`, sends a confirmation, and restarts Tomo. Built-in config writers now copy the current config to `config.json.bak` before mutating it, including `/model`, group activation, `tomo config`, and re-running `tomo init` over an existing config.

### Bug fixes

- **Surface SDK model errors in chat.** Some SDK-originated errors, including invalid selected-model messages, arrive as assistant text blocks without stream deltas. Tomo now pushes those assistant blocks into the channel stream before sealing them, so Telegram and iMessage users see the error instead of a hanging turn.

### Docs

- Updated `tomo-system` docs and README with the config backup rule, `sessionModelOverrides` behavior, and `/restore` command.

## 0.5.8 (2026-05-12)

### Features

- **Private memory for DMs only** (#97). New `~/.tomo/workspace/memory/private/` subdir holds memories the agent shouldn't surface in group chats. DM sessions see the full MEMORY.md index and can Read/Write under `memory/private/` normally; group sessions get the index with `private/` links stripped *and* a `PreToolUse` hook that denies any tool call that could reach the dir. The system prompt's privacy section flips per session type so the agent knows the rule. Per Anthropic SDK docs, `PreToolUse` denials bypass `canUseTool` so the guard holds even though Tomo runs in `bypassPermissions` mode. Enforcement evolved across review rounds — final shape uses path resolution + `minimatch` reachability probes rather than substring matching:
  - File ops (Read/Edit/Write/MultiEdit/NotebookEdit): resolved `file_path` must not land inside `memory/private/`.
  - Glob/Grep: pattern tested against synthetic probe paths anchored under `private/` (catches `pri*`, `{public,private}`, `p[a-z]*`, case permutations); Grep also denies basename globs like `-g '*.md'` from any root that can reach private/, because ripgrep applies basename filters at every depth.
  - Bash: denies any command that names `memory` or `private` as a path segment, or that contains the absolute private dir. Shell expansion happens after the hook fires so per-token resolution can't catch `cat memory/pri*/*.md` reliably — Bash on the memory tree is just denied wholesale. Group sessions can still Read public memory files by name (MEMORY.md is already in the prompt).
- **Turn budget warnings at 75% and 90% of `maxTurns`** (#96). The SDK enforces `maxTurns` silently and only surfaces the limit as an error after the fact, so long agent loops would die mid-thought. A new `PostToolBatch` hook counts tool rounds per `send()` call and injects an `additionalContext` system reminder when usage crosses the thresholds — at 75% the agent is nudged to wrap up; at 90% it's told the SDK will abort imminently. Budget resets per user message → response cycle, so a single long turn doesn't poison the next one. `PostToolBatch` fires exactly once per model→tools→model round, which is the right granularity for turn counting.

### Internal

- **Permission logic extracted to `src/agent/permissions.ts`.** `sdk-options.ts` had grown to 405 lines with permission code (canUseTool callback + private-memory guard) accounting for ~45%. Split into a dedicated module so future guards have a clear home; `sdk-options.ts` is back to SDK option assembly and turn-budget nudges.

### Other

- Bump `@anthropic-ai/claude-agent-sdk` 0.2.138 → 0.2.139.
- Bump `@clack/prompts` 1.3.0 → 1.4.0.
- Bump dev dependencies: `@types/node` 25.6.2 → 25.7.0, `vitest` 4.1.5 → 4.1.6, `@vitest/coverage-v8` 4.1.5 → 4.1.6, `typescript-eslint` 8.59.2 → 8.59.3.
- New direct dependency: `minimatch` ^10.2.5 (already a transitive dep) — used by the private-memory guard to evaluate Glob/Grep pattern reachability.

## 0.5.7 (2026-05-10)

### Other

- **Migrate the deprecated `"Skill"` allowedTools entry to the top-level `skills: "all"` option (#94).** SDK v0.2.133 [release notes](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.2.133) deprecated passing `'Skill'` in `allowedTools`; the SDK now appends `"Skill"` (or `"Skill(name)"` per entry) to the spawned CLI's `--allowedTools` only when `skills` is defined. Setting `skills: "all"` keeps every discovered skill in `.claude/skills/` invocable with the same surface as before, while shedding the soon-to-be-removed pattern.
- Bump `@anthropic-ai/claude-agent-sdk` 0.2.126 → 0.2.138 (#92). Tracks Claude Code through v2.1.138. Notable from the intervening releases: `resolveSettings()` alpha API to inspect merged effective settings without spawning the CLI (v0.2.136), plus deprecation notices for the `unstable_v2_*` session API → `query()` (not used here) and the `'Skill'` allowedTools pattern handled above.
- Bump `zod` 4.4.2 → 4.4.3 (#93).
- Bump dev dependencies group: `@types/node` 25.6.0 → 25.6.2, `typescript-eslint` 8.59.1 → 8.59.2 (#91).

## 0.5.6 (2026-05-05)

### Features

- **Inbound PDF support** (#89). Both iMessage and Telegram channels now accept PDF attachments and forward them to the agent as Anthropic `document` content blocks (alongside the existing `image` blocks). When `saveInboundImages` is on, PDFs are also persisted to `{workspaceDir}/memory/incoming-documents/YYYY-MM-DD/HHMMSS_{session}_{guid8}[_filename].pdf`, parallel to the image store. New `documentStore.ts` exposes `saveInboundDocument`, `formatDocumentMarker`, `documentMimeToExt`, and `isSupportedDocumentMime`; the supported MIME list is currently `["application/pdf"]`. Anthropic's 32 MB per-PDF cap is enforced by `MAX_DOCUMENT_BYTES`; oversized attachments are dropped with a warn log so memory and disk stay bounded. Size enforcement is layered: each channel pre-checks the declared size hint (BlueBubbles `totalBytes`, Telegram `Document.file_size`) before any HTTP work, then the HTTP `Content-Length` header at fetch time, then a streaming reader cap (`readBodyWithCap`) that hard-stops accumulation past the cap and cancels the underlying stream — so a 100 GB PDF never spikes memory regardless of which size hint is missing or wrong. iMessage downloads PDFs in the same pass as images (one BlueBubbles round-trip), Telegram adds a dedicated `message:document` handler that filters by MIME before downloading. `IncomingMessage` gains an optional `documents?: DocumentAttachment[]` field; `live-session.ts` emits `{ type: "document", source: { type: "base64", media_type, data }, title }` blocks and the agent threads documents through `runWithRetry` and `handleBatchedMessages` mirror to the existing image plumbing. Unsupported document MIMEs on Telegram still surface as a plain text marker so the agent doesn't see "user sent something" without context.

### Other

- Bump `@anthropic-ai/claude-agent-sdk` 0.2.123 → 0.2.126 (#88).
- Bump `zod` 4.4.0 → 4.4.2 (#87).
- Bump dev dependencies group: eslint update (#86).

## 0.5.5 (2026-05-01)

### Features

- **Inbound image marker is now always emitted, with the saved disk path when local storage is on.** Previously, a `[Sent an image]` fallback only appeared when the user sent an image with no caption — captions replaced the marker outright, and the model couldn't see the on-disk file path even when `saveInboundImages` was on. Now both Telegram and iMessage prepend `[Sent an image]` (or `[Sent N images]` for iMessage's multi-attachment messages) to the user's caption, and append `saved to: /abs/path[, /abs/path…]` when storage is enabled. The agent can now reliably know an image was attached and `Read` it from disk for tool work that goes beyond what the inline content blocks support. New `formatImageMarker(intendedCount, savedPaths)` helper in `channels/imageStore.ts`; both channels thread `savedPath` through `ImageAttachment`. Marker reflects intended-image count, so a download failure for one attachment doesn't hide the fact that an image was sent.

### UX

- **Group sessions default to hierarchical LCM compaction.** `config.lcm.groupCompactStyle` now defaults to `"lcm"` instead of `"sdk"`. Group sessions get the same daily/weekly/monthly/yearly rollup nudges, %-based compact prompts, and `tomo-lcm-stats` MCP tool that DMs already had. Set to `"sdk"` to opt back into SDK auto-compact for groups. Existing installs with the field unset flip on next `tomo start`. Rollup nudges for group sessions splice in a "Group scope" line so summaries stay focused on that group's conversation rather than mixing in personal/DM context.
- **`tomo-cron` skill removed; the `schedule_*` MCP tools are now the everyday interface.** The standalone `tomo-cron` skill was redundant once `schedule_create` / `schedule_list` / `schedule_remove` landed on the `tomo-internal` MCP server in 0.5.3. The `tomo-system` skill now briefly mentions the three MCP tools and notes that the `tomo cron …` CLI remains for human debugging (auditing the job store, fixing a stuck job after a restart). Built-in skills list trimmed accordingly.
- **`tomo-browse` skill switched from `playwright-cli` to `agent-browser`.** New skill content is a thin discovery stub pointing at `agent-browser skills get core`, so workflow guidance always tracks the installed CLI version instead of going stale in this repo. Frontmatter description broadens trigger coverage to web automation, exploratory testing, Electron app automation (VS Code, Slack, Discord, Figma), Slack workspace tasks, Vercel Sandbox, and AWS Bedrock AgentCore.

### Bug fixes

- **`lcm compact`: fix write race that could clobber events the SDK appended while `compactSession` was running.** Symptom: when an agent invokes a long-running `tomo lcm daily/weekly/...` via Bash tool, the SDK's `thinking` + `tool_use` events for that very turn could land on disk between compactSession's initial read and its truncate-rewrite, then get wiped by the rewrite. The subsequent `tool_result` then had a `parentUuid` pointing at a vanished tool_use, breaking the chain.
  - Fix: capture the file size at read time, re-read the tail at write time, splice any late-arriving events into the new content, and write atomically via `<path>.compacting.tmp` + `rename`.
- **iMessage typing indicator: stop the flicker.** BlueBubbles' typing decays server-side faster than Telegram's, so the previous 6-second refresh cadence raced the decay and left the indicator visibly turning on/off between ticks during long SDK turns. Three changes: (1) refresh interval dropped from 6 s to **3 s**; (2) added a `tickInFlight` guard so a slow BlueBubbles HTTP server doesn't queue overlapping POSTs; (3) added Tomo-Telegram-style consecutive-error suspension — after 10 consecutive failed POSTs (e.g. Private API helper missing), typing self-suspends with a single `log.warn` and explicitly DELETEs the indicator instead of hammering the endpoint forever. Cross-checked the design against the openclaw bluebubbles extension's typing controller (`openclaw/src/channels/typing.ts`), which uses the same 3 s default and `tickInFlight` pattern.

### Internal

- **Built-in skill prune on startup.** `cli/start.ts` now removes `~/.tomo/workspace/.claude/skills/tomo-*` directories that no longer have a counterpart in bundled `defaults/skills/`. Custom skills (anything not prefixed `tomo-`) are never touched. Without this, retired built-ins like `tomo-cron` would persist forever on existing installs.

## 0.5.4 (2026-04-29)

### Features

- **Group chat rename MCP tool**: `tomo-internal` now exposes `rename_group_chat(target, title)` for explicit user-requested group title changes. Telegram uses Bot API `setChatTitle`; iMessage uses BlueBubbles Private API `PUT /chat/:guid` with `displayName`. Successful renames update Tomo's persisted `chatTitle` immediately so `list_sessions` reflects the new name.
- **Latest-message reaction MCP tool**: `react_to_latest_message(target, reaction, remove?)` reacts/tapbacks to the latest inbound message Tomo has seen in a session since startup. Telegram uses `setMessageReaction`; iMessage uses BlueBubbles Private API `POST /message/react`. Supported cross-channel reactions are `love`, `like`, `dislike`, `laugh`, `emphasize`, and `question`.
- **Telegram sticker sending**: responses can now include `STICKER:<telegram_file_id>` to send a Telegram sticker via `sendSticker`, mirroring the existing `MEDIA:` attachment tag flow.
- **Telegram sticker ingress**: inbound Telegram stickers now arrive as text metadata including `file_id`, optional emoji/set/type flags, and a ready-to-use `STICKER:<file_id>` resend hint.

## 0.5.3 (2026-04-28)

### Features

- **Cron exposed as MCP tools** (#72): `schedule_create`, `schedule_list`, `schedule_remove`. Three deferred tools on the existing `tomo-internal` server, alongside `send_message` / `list_sessions`. Selected over keeping cron Bash-only because (1) ~99% of cron operations originate from the agent, not from a human terminal, and (2) the structured-args path eliminates the class of CLI-flag-default bugs (cf. the `--once` fix in this same release). With tool search default-on in the Agent SDK, the schemas only land in context when the agent searches for scheduling capability — no per-turn cost. Names use `schedule_*` rather than `cron_*` to avoid namespace collision with Anthropic's built-in `CronCreate / CronList / CronDelete` deferred tools surfacing in the same search. Handlers instantiate a fresh `CronStore` per call so they pick up writes from the CLI, the scheduler daemon, or external edits — the on-disk JSON is the single source of truth. The `tomo cron …` CLI is preserved as a parallel surface for human audit/debug.

### Bug fixes

- **`tomo cron add` honours the `at`-default for `deleteAfterRun`** (#71). The `--once` Commander option carried a `false` default, so `opts.once ?? (schedule.kind === "at")` always resolved to `false` and one-time `at` schedules were created with `deleteAfterRun=false`. The store layer's default already does the right thing for one-time schedules; the fix is to drop the CLI default so `opts.once` stays `undefined` when the flag isn't passed and the store's fallback can fire. Observed live: a one-time visa-interview reminder created via `--schedule "at 2026-04-27T09:00"` fired correctly but lingered as a `disabled` zombie in `cron list` instead of cleaning itself up.
- **`schedule_create` invalid-schedule path no longer escapes the handler** (#72). `parseScheduleString` accepts any unrecognized string as `kind: "cron"` (catch-all), and croner throws inside `computeNextRun` on a malformed expression. The original try/catch wrapped only the parse step, so a string like `"this is not a schedule"` passed through to `store.add()` and the croner throw escaped uncaught. The try now covers parse + add together.

### UX

- **`tomo cron list` and `cron add` surface lifecycle** (#71). Each row now reads `(<enabled|disabled>, <once|recurring>)` and the `add` confirmation prints a `Type:` line. The previous output gave no in-CLI signal that a cron expression like `0 19 1 5 *` was about to silently re-fire every May 1 — operators had to grep `~/.tomo/data/cron/jobs.json` for `deleteAfterRun` to audit one-shot intent vs. behaviour. The `tomo-cron` skill doc gains a "one-shot trap with cron expressions" section recommending ISO-date and `in Xd` schedules over date-pinned cron expressions for single-fire reminders.

## 0.5.2 (2026-04-27)

### Bug fixes

- **LCM rollup runner emits one nudge per tick** (#70). Previously stuffed every due promotion into a single `System:` message, which the LLM ran as back-to-back `tomo lcm` Bash calls in one turn — and back-to-back compacts mid-turn race the SDK's in-memory state, orphaning the parent chain. Now sorts due promotions by level (daily → weekly → monthly → yearly) then period (oldest first) and emits only the head; the next heartbeat picks up the next one. Trade-off: backlog drains over multiple ticks instead of all at once. `nudgeText` made singular and explicitly warns against chaining multiple compacts in a single turn.

## 0.5.1 (2026-04-26)

### Features

- **Coalesce queued messages into one turn** (#67). When multiple DMs (or messages in a passive group) arrive while a turn is in flight, they merge into a single follow-up SDK turn instead of firing one turn per message. Lets the agent see `"do X"` → `"wait"` → `"actually nevermind"` together and skip wasted work on retracted requests. Mention-required groups bypass coalescing because per-message mention filtering would be lost. Passive group batches use sender-prefixed lines (`Alice: ...` / `Bob: ...`) plus a header noting the messages came from a group. Each user message still appends individually to the on-disk transcript; only the SDK prompt is merged.

### Bug fixes

- **Telegram NO_REPLY no longer leaks via the streaming first frame** (#66). The streaming placeholder was sent before the model finished, so a NO_REPLY response left an empty/partial message in the chat. `StreamingMessage` now exposes `cancel()`, called in the NO_REPLY path (and the new batched path) after the SDK turn completes — cancels the placeholder before any visible content lands.
- **Channel ingress was serializing against the SDK turn** (#67). grammy's `bot.on(...)` awaits its handler body before reading the next update, and the iMessage dispatch did the same — both then awaited `enqueueMessage`'s task-completion promise, so the channel layer waited a full SDK turn before delivering the next message. Result: messages never piled up in the queue, and the new coalescing was effectively dead in production. Three layers of fix (defense-in-depth): `telegram.ts` and `imessage.ts` dispatch fire handlers without awaiting; `agent.enqueueMessage` returns once queued, not when the turn completes. Regression test models the serial channel-loop pattern.

## 0.5.0 (2026-04-26)

### Features

- **Proactive messaging via `send_message` MCP tool** (#64). New in-process MCP server (`tomo-internal`) exposes `send_message(target, message, mode)` and `list_sessions()`. Two modes: `delegate` (default) hands the request to the recipient session's Claude as a system message — that Claude composes the actual message in its own voice with full local context (participant names, recent conversation, group tone); fire-and-forget via the existing `handleCronMessage` primitive, the user observes the outcome directly in the recipient channel. `direct` posts verbatim text via `Channel.send()` without triggering a recipient Claude turn — best for factual broadcasts and self-targeted mid-loop progress updates. `list_sessions` returns identities and active groups with `chatTitle` + `participants` metadata, both now persisted on `SessionEntry` in `_sessions.json` (existing group entries populate on next group activity).
- **Configurable `maxTurns`, default raised to 50** (#64). The Agent SDK `maxTurns` ceiling (one turn ≈ one tool-use round) is now read from `config.maxTurns` instead of being hardcoded to 30. Override via `maxTurns` in `~/.tomo/config.json` or `TOMO_MAX_TURNS` env.
- **`canUseTool` callback grants writes under `<workspaceDir>/.claude/skills/`** (#64). The SDK's `bypassPermissions` mode does not actually exempt `.claude/` writes despite the docs implying it does, so creating/editing skills via Edit/Write hung on a permission prompt with no UI to approve. A narrow callback now auto-approves writes under the workspace's `.claude/skills/**` (Write/Edit/MultiEdit/NotebookEdit, plus Bash commands targeting that path); everything else that reaches the callback is denied with a descriptive message.
- **Per-Telegram-group passive listen mode** (#64). New `channels.telegram.passiveGroups: string[]` config field accepts a list of group chatIds. In those groups, Tomo sees every message (no `@mention` required) and decides via `NO_REPLY` whether to respond — same shape as iMessage groups have always behaved. The typing-indicator skip and error-message suppression in `handleMessage` are generalized via a single `isPassiveListenGroup(channel, chatId)` helper. iMessage groups remain implicitly passive (no config needed).
- **Group context moved into the system prompt** (#64). The "you are in <title>, participants are X, listen mode is passive, NO_REPLY for noise" instructions previously injected as a one-time runtime turn via `updateGroupContext` are now part of the per-session system prompt block (under a new `## Group Chat Context` heading). Survives LCM compaction — earlier the rules could be summarized away, after which Tomo would start replying to passive-group chatter. `updateGroupContext` is now pure persistence (participants + title to `_sessions.json`); no more per-new-participant Claude turn cost. Snapshot of participants in the prompt is from session-creation time; new joiners are still cued by the `<sender>: <text>` message format.
- **Tool result events logged with originating tool name** (#64). Previously `consumeEvents` handled assistant `tool_use` blocks but silently dropped user `tool_result` blocks, making it impossible to tell from the log whether a failed tool call was harness-rejected vs the model misreading. Adds a `pendingToolNames` map (tool_use_id → name) on `LiveSession` so result lines can be labelled, plus `summarizeToolResult` truncating to a 500-char readable line. `is_error` is surfaced at INFO level so failures stand out.

### Other

- **`cli --version` now reads from `package.json` at runtime** (#64). Resolves the long-standing drift risk flagged in `0.4.1`: `src/cli.ts` previously hardcoded the version string and required a parallel update on every release bump. Now derived from `import.meta.url` → `../package.json`, so the package.json bump is the single source of truth.

## 0.4.2 (2026-04-24)

### Bug fixes

- **LCM past-day rollups no longer stuck** (#58). `DAILY_FRESH_TAIL = 32` (the guard that preserves warm context when rolling up today) was being applied to past days too — any past day with ≤32 raw events returned "No events found" and never promoted, even as the `RollupRunner` kept nudging every tick. Gate the fresh-tail branch on `resolvedPeriod === today`; past days compact in full. Observed in-session: dailies 04-08 (28), 04-11 (32), 04-15 (10), 04-16 (11), 04-19 (15) all stuck.
- **LCM nudges past days with leftover raw after a daily block** (#59). `findDuePromotions` previously skipped any past day whose `daily <day>` tag already existed, even when extra raw events sat outside that block. Observed: `daily 2026-04-22` absorbed ~408 events, then 238 more accumulated after and never got swept up. Now flags past days that have raw events regardless of existing block, with a floor of 8 events to suppress small residuals. Rebuild semantics of `tomo lcm daily --date <day>` absorb both the existing block and the leftover raw.

### Documentation

- **Realistic LCM summary target lengths for bilingual use** (#60). Original targets (daily 300–1000 tok, weekly 500–1500, monthly 1000–2000, yearly 1500–3000) assumed pure English; in bilingual Chinese/English practice CJK characters tokenize ~3× denser, so real summaries consistently ran 3–6× over target. New ceilings: daily 1,000–2,500, weekly 2,000–4,000, monthly 3,000–6,000, yearly 5,000–10,000 tokens. Hierarchy compression ratios still hold (~3–5× per level). Also removed a stale "hot-tail > 40 events" line in `SKILL.md` that predated the context-% nudging.

### Other

- Bump `actions/upload-artifact` 4 → 7 (#54).
- Bump dev dependencies group: 4 updates (#55).

## 0.4.1 (2026-04-19)

### Features

- **Persist inbound images to disk** (#57). Every image received via iMessage or Telegram is now additionally written to `<workspace>/memory/incoming-images/YYYY-MM-DD/HHMMSS_<session>_<guid8>.<ext>` at download time, in addition to the existing base64 inlining into the SDK event. Previously images lived only in the session archive and vanished from the agent's view on compaction. New `saveInboundImages` config flag (default `true`) gates the behavior; set to `false` in `~/.tomo/config.json` to disable.

### Other

- `cli --version` synced to `0.4.1` (was stale at `0.3.7` across 0.3.8 – 0.4.0 releases). Still hardcoded — a follow-up to read from `package.json` at runtime would prevent this drift recurring.

## 0.4.0 (2026-04-17)

### Features

- **Hierarchical block rollups for LCM**. New `tomo lcm daily|weekly|monthly|yearly` subcommands auto-resolve the calendar period and event range, tagging each summary with a canonical `blockTag` (e.g. `daily 2026-04-17`, `weekly 2026-W16`, `monthly 2026-04`, `yearly 2026`). Each level consumes the one below — weekly rolls up 7 daily blocks into one, monthly consumes weeklies, yearly consumes monthlies. Steady state for a long-running session is bounded at ~30 summaries regardless of age.
- **Rebuild semantics on daily blocks**. Running `tomo lcm daily` mid-day replaces the existing `daily YYYY-MM-DD` block with a fresh summary that absorbs any new raw events since the last write. Safe to run multiple times per day.
- **Automatic promotion detection**. A new `RollupRunner` scans active sessions hourly (daytime only) for completed calendar units with un-promoted children. When found, it injects a `System:` nudge to the agent describing which rollup commands to run. Idempotent — catches missed Mondays on Tue/Wed.
- **Hot-tail cap hysteresis**. After each turn, if today's raw (non-summary) event count exceeds 40, the harness nudges the agent to run `tomo lcm daily` to compress. Debounced at a low-water mark of 24 so it doesn't thrash.
- **New skill docs** (`defaults/skills/lcm/SKILL.md`, `DAILY.md`, `WEEKLY.md`, `MONTHLY.md`, `YEARLY.md`) explaining the block-rollup mental model and style guidance per level. The time-range `compact` command is now documented as an escape hatch for surgical middle-range compactions.

## 0.3.10 (2026-04-17)

### Bug fixes

- `lcm compact`: archive compacted events to `_archive_<sdkSessionId>.jsonl` always, matching `store.searchArchive()` and `prune-tools`. Previously when `--channel-key` was passed the archive went to `<channelKey>.jsonl`, colliding with the live transcript namespace (e.g. `dm:shuai.jsonl` next to `dm_shuai.jsonl` — two files, different schemas, same directory).

## 0.3.9 (2026-04-17)

### Bug fixes

- `lcm compact`: re-parent every post-range event whose `parentUuid` pointed into the removed range, not just the first one. Previously only the first post-range user/assistant event was re-linked to the summary, leaving any sibling events (tool chains, split assistant content blocks, attachments) orphaned. On SDK resume those broken links caused the chain walker to skip the compact summary entirely — summaries were written to disk but never reached the API.
- `tomo restart`: wait for the old PID to exit and a new one to come up (up to 60s) before reporting success, and fall back to a direct SIGTERM if the running tomo wasn't actually the launchd-managed instance. Previously `launchctl kickstart -k` returned immediately; the CLI printed success while the old process was still draining, and in some cases the signal never reached it at all.

### Other

- `scripts/`: add one-shot session recovery utilities (`repair-session.ts`, `prune-session.ts`, `compact-session.ts`) for sessions that got damaged by the pre-fix compactor or grew too big to resume through the agent.

## 0.3.8 (2026-04-16)

### Features

- Default Opus model upgraded from Claude Opus 4.6 to Claude Opus 4.7 (#45).

### Bug fixes

- Message isolation: user messages, cron triggers, and continuity heartbeats now share a single FIFO queue per session. Previously only user messages were serialized, which let concurrent cron/heartbeat ingress stomp on an in-flight user turn's `currentRequest` slot inside `LiveSession` and cause response hijacking + 5-minute timeouts.
- Bump per-`send()` timeout 5m → 10m to accommodate longer tool-using turns.

## 0.3.7 (2026-04-12)

### Features

- `tomo update` — check for new versions, install, and restart in one command
- `tomo config` — add cost analysis view with per-session spending breakdown (#43)
- Version notification now tells users to run `tomo update` instead of manual npm commands

### Other

- Add code coverage and CodeQL security scanning (#42)
- Add `.nvmrc` for consistent Node version
- Add Dependabot for weekly dependency updates (#36)
- Bump commander 13.1.0 → 14.0.3, pino 9.14.0 → 10.3.1, croner 9.1.0 → 10.0.1, @anthropic-ai/claude-agent-sdk 0.2.92 → 0.2.104
- Fix npm publish workflow for OIDC trusted publishing (#31, #32, #33, #35)

## 0.3.6 (2026-04-11)

### Features

- `tomo backup` — create, list, and restore backups of config, workspace, data, and SDK session files
- 14-day rolling retention, atomic writes (`.tmp` + rename), and custom skills included in backups
- Restore blocks while daemon is running and preserves `.claude/` directory
- Backup commands documented in `tomo-system` skill

## 0.3.5 (2026-04-10)

### Features

- Cron jobs now target a single required `--session <key>` flag instead of `--channel`/`--chat-id`, so the agent can schedule reminders that fire back to any session — DM, unified identity (`dm:<name>`), or group chat — just by passing the `Session key` from its system prompt
- Agent's system prompt now shows `Session key: <key>` under the SESSION block (was `Channel key`)
- Identity changes in `tomo config` eagerly rewrite matching cron jobs: creating or editing an identity moves per-channel cron jobs onto `dm:<name>`, and removing an identity moves them back to a concrete per-channel key — no stale pointers after migration
- New `IdentityRouter.deriveReplyTargetFromConfig` fallback lets a `dm:*` cron fire correctly even before the identity has ever received a message (derives the reply target from `replyPolicy` + `identity.channels`)
- Commit and PR attribution via the SDK's native `settings.attribution` field — tomo now stamps `Made by [Tomo](https://github.com/shuaiyuan17/tomo)` on commits and PRs it creates
- New `tomo-system/CONFIG.md` level-2 skill reference: full `~/.tomo/config.json` example with every supported field, type table, `replyPolicy` options, env-var overrides
- `tomo-cron` skill doc explains where reminders get delivered and when to pass `--session $SESSION_KEY` (the "remind me" vs "remind us" heuristic)

### Bug fixes

- `tomo restart` now recovers when the LaunchAgent plist is on disk but the service isn't loaded (e.g. after `tomo stop`) — `kickstart` falls through to `bootstrap` automatically instead of failing with `Could not find service`
- `tomo restart` with autostart disabled now returns a clear `Autostart is not enabled…` error instead of a raw launchctl failure

## 0.3.4 (2026-04-09)

### Features

- Start Tomo automatically when you log in (macOS) via a LaunchAgent at `~/Library/LaunchAgents/ai.tomo.plist`
- Prompt to enable autostart during `tomo init`; toggle later from `tomo config` → Autostart
- Add `tomo uninstall` command that stops the service and removes the login-item (keeps `~/.tomo/` data)

### Bug fixes

- `tomo stop` and `tomo restart` now route through `launchctl` when autostart is enabled, instead of killing the pidfile'd process (which `KeepAlive` would have respawned)

## 0.3.3 (2026-04-09)

### Features

- Add startup disclaimer about AI risks, prompt injection, and allowlist hygiene
- Prune base64 images in `prune-tools` LCM tool

### Bug fixes

- `prune-tools` now prunes `toolUseResult` previews and triggers a session reload after pruning

## 0.3.2 (2026-04-09)

### Features

- Channel-aware timestamps in session context
- `/status` command
- `prune-tools` LCM tool for trimming tool-result bloat
- Skill auto-sync on startup (defaults copied over on upgrade)
- ASCII banner

### Bug fixes

- Improve auth check error message to mention usage limits

## 0.3.1 (2026-04-09)

### Bug fixes

- Lazy-load config in the `lcm` CLI so `init` and `status` don't crash on fresh installs
- Fix compaction session reload by using the SDK's `close()` method
- Fix Telegram flush race condition and expand test coverage
- Clarify context stats timing in `lcm` and system skills

## 0.3.0 (2026-04-08)

### Features

- iMessage support via BlueBubbles, with multi-channel session routing
- Per-channel allowlists to restrict who can message Tomo
- Group chat support with activation via a secret passphrase
- Interactive `tomo config` TUI for managing settings
- Collect Telegram user ID during `tomo init` and manage the allowlist from the TUI
- Resolve iMessage sender addresses to contact names
- Per-session message queue to prevent LiveSession contention
- Config TUI: session picker when binding DM chat IDs, and all 5 model variants listed (including 1M context)
- Default model is now Sonnet 4.6 (non-1M) for new users

### Bug fixes

- Match iMessage allowlist and identity entries by phone number or email
- Normalize identity session keys to lowercase
- iMessage groups: skip typing indicator and suppress error messages
- iMessage groups: treat all messages as mentioned with silence guidance

## 0.2.1 (2026-04-08)

### Features

- Add context window breakdown by category to session metadata
- Auto-nudge agent to compact when context hits 80%

### Bug fixes

- Surface API errors to Telegram instead of silently swallowing
- Split cost log into per-turn and cumulative session total
- Fix totalCostUsd double-counting in session stats

## 0.2.0 (2026-04-08)

### Features

- Add LCM (Long Context Management) tools for context compaction and archive search
- Enable 1M context window beta support
- Auto-reload session after compact
- Add `migrate` command

### Bug fixes

- Auto-restart Telegram polling when it dies silently
- Fix image support and add timeout
- Always overwrite default skills on startup

### Other

- Update browse skill: headed mode, persistent profile, named session

## 0.1.4 (2026-04-07)

### Features

- Streaming input mode with session stats
- Add continuity heartbeat system
- Add media sending and browser skill
- Add `/model` command and proactive memory
- Auto-sync default skills and files on startup

### Bug fixes

- Fix `MEDIA:` tag showing in streamed messages

### Other

- Add GitHub Actions CI (Node 22 & 24)

## 0.1.0 (2026-04-06)

Initial release.
