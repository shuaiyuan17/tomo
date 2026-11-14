# Local web chat

`tomo start` starts the optional web UI on **127.0.0.1:9465**. Read the private access link with `cat ~/.tomo/web-access.log`; it includes `?t=<token>`. The page removes this parameter from the address bar and uses an HttpOnly cookie thereafter. At least one existing messaging channel must still be configured.

```json
{
  "web": {
    "enabled": true,
    "port": 9465
  }
}
```

The web chat is always the owner's DM session (`dm:<owner.name>`). With no owner configured, chat stays disabled (`owner_setup_required`) until one is set and Tomo restarts. `web.ownerIdentity` is only read for older configs with several `identities`, to pick which one becomes the owner. Set `enabled` to `false` to disable the UI. Invalid web settings disable only the UI and emit a diagnostic.

## Conversations

- A message sent while Tomo is working shows at once (Queued). In the owner DM it joins the running turn when that turn is the owner's own private reply turn, like a mid-turn iMessage; otherwise it waits its turn in the session queue. Once a joining message has been handed to the model it is never retried: if the turn then fails it reads back as "outcome unknown", because it may already have run.
- Owner messages use the existing DM session, Agent queue, SDK, delivery filters, and transcript. Replies from browser input go to the browser. Messaging channels and scheduled notifications retain their normal destinations.
- Groups are read-only: select a group to inspect its history and recorded context use. Browser group writes are refused by both the HTTP service and daemon.
- Replies appear one completed content block at a time. Tool activity shows names and status from attributed watch events; tool arguments and results are omitted.
- History is the canonical transcript, including recorded replies that may have been silent or failed delivery. It is not a read receipt. Existing transcript policies are preserved. The current request status separately reports web delivery failure.
- **Tasks** (right sidebar; the topbar checklist button pins it open or collapses it, badges the running count, and is remembered per browser; on narrow screens it slides over the conversation) lists running subagents and background tasks for the owner's DM and each group, read-only: description, elapsed time, and `Working · <latest step>` when the SDK reports progress (the task type is in the tooltip). Nested tasks are indented under their parent. Watchers and other ambient tasks are hidden unless **Show watchers** is ticked. A finished task stays for about a minute, marked Done/Failed/Stopped/Ended. Source: the SDK's `background_tasks_changed` (REPLACE) set plus `task_started`/`task_progress`/`task_updated`/`task_notification`; prompts are never carried. Only sessions the browser can already read appear: groups, and the one DM key the session catalog shows as the owner conversation. The reconnect snapshot is complete, with shortened descriptions and summaries. The panel shows at most 128 tasks: running tasks first (watchers last), shared fairly across conversations; a task that does not fit appears as soon as there is room. On narrow screens the overlay takes focus, keeps it until closed, and closes with Escape.
- A subagent's card and view show its model as a small badge (e.g. "Opus 5.5"), read from the first assistant entry of its transcript once it exists (the SDK's task events carry no model). Shell and other tasks have none.
- Click a task to read it, read-only. A subagent shows its transcript in order: assistant text, then each tool call folded to one line (`Read src/web/http.ts`, `Bash: npm test`) that expands to its input and output (capped server-side at 4,000 characters each; "Show more" expands within that cap). The subagent's own prompt is not shown. Long transcripts load the newest page first; "Load earlier" pages back. While the task runs, the view polls every 2 s for the lines appended since the last read, and reads once more after it ends. Shell and Monitor tasks show the end of their output (the SDK's `get_task_output`, at most the last 8 KiB, escape sequences stripped). Only a task the panel currently shows can be opened (the exact set the panel's send gate last published, after expiry, the owner rule and the capacity share), and tool input/output is secret-scrubbed like the logs. Pages never split a transcript entry; an entry with more than 400 blocks shows the first 400 and says how many it left out. At most 2,000 items stay in memory; whatever is dropped can be loaded again ("Load earlier" / "Load newer"). The Tool and Terminal views are adapted from AI Elements (Apache-2.0); the license ships as `dist/web-assets/THIRD_PARTY_LICENSES.txt`.
- Messages keep single line breaks (as typed in iMessage); code blocks and markdown lists are unaffected. Images and stickers sent from a messaging channel show as thumbnails (click for full size), documents and files as a named chip — never the stored path. Images are served by `/api/v1/sessions/:id/media` (cookie-authenticated, same-origin image fetches only, `no-store`). Transcripts keep no structured attachment record, so a file is served only if a history page this process served for that visible session named it in the leading marker of an inbound user message from Telegram or iMessage, its name carries that session's own channel-chat prefix, its real path is under `memory/incoming-images` (not `memory/private`), it has a single link, its bytes are a PNG/JPEG/GIF/WebP/HEIC signature matching its extension, and it is at most 15 MB. At most 20 thumbnails show per message ("+N more"). iMessage replies show the quoted message as a small card; when the original is in the conversation, clicking the card scrolls to it and highlights it.
- Context uses the same persisted `contextUsed` / `contextMax` values as the CLI. Estimated values are labeled. A missing window is unavailable.

## The Study

**The Study** (left sidebar, or `#study/<page>`) is a view of the workspace; apart from the cron actions below it is read-only. Every read uses the same authentication as chat and runs in the web process, never on the daemon thread.

- **TODOs:** root-level `memory/TODO*.md` files with their checkbox state (nested TODO files stay browsable in Memory).
- **Memory:** browse `MEMORY.md`, topic files and subdirectories; search literal text and open results.
- **Context:** for the conversation selected in the sidebar (owner DM or a group): persisted window usage and breakdown, the same estimated sections as `tomo lcm stats`, retained rollup blocks as in `tomo lcm blocks`, and compactions seen since the daemon started (not a complete audit log). A missing window is unavailable, not zero.
- **Cron:** names, schedules, target sessions, messages, next/last runs and status, read fresh from the scheduler's store file. The daemon hands the web process that path; the web process reads it asynchronously (at most 4 MiB, `413 cron_store_too_large` beyond), refuses symlinks, FIFOs and other non-regular files, and parses it with the store's own side-effect-free parser. Each job can be paused, resumed or deleted after a confirmation that names it. The change passes the same bounded read, then goes through the store's own guarded, locked load-modify-save (as `tomo cron` does) and only if the job still has the intent you reviewed (name, schedule, message, session, enabled, one-shot); a run starting or finishing meanwhile does not invalidate it, an edit does (`409 cron_changed`). A run already in progress is not stopped. Resuming a one-shot whose time has passed runs it at the scheduler's next check; a recurring schedule with no future run is refused (`422 unschedulable`).
- **MCP servers:** saved definitions, including disabled ones, with the state live SDK sessions report (connected, failed, needs sign-in…). Health is never probed and no connection or OAuth flow is started; no report means unknown.
- **Config:** the saved `config.json`. Values the daemon is running with may differ until it restarts.

The Study's only writes are the cron actions. Like a message, each needs the exact Origin, the session cookie, the CSRF header, a JSON body with `confirm: true`, and the daemon epoch the page loaded under (`409 epoch_changed` after a restart). A definite CSRF rejection is retried once with a refreshed token; nothing else is retried.

`memory/private/` is never listed, read or searched by the Study, not even for the owner. It uses the agent's own private-memory fence (`landsInPrivate`: lexical, real-path and case-folded), a private path reads as not found, and `MEMORY.md` lines that link into `private/` are withheld, as in group prompts. Config strings are shown only on an allowlist of known non-sensitive paths (`SHOWN_STRING_PATHS` in `src/web/config-view.ts`: models, modes, channel / chat / session identifiers, time zone, paths, tool names, MCP `type`), and even then not if the value looks like a credential. A path with a wildcard (`sessionModelOverrides.*`, `identities.*.channels.*`, `plugins.*`, …) shows its keys, but a value only when it passes that path's check (a model id of at most 64 characters, a chat id, a lowercase channel name, a file path, …); a wildcard path without a check never shows a value, and a key that looks like a credential is shown as `•••`. Every other string, including any field added later, shows as `•••` with its length. Numbers and booleans are shown unless a path segment names a credential or they are an opaque MCP value (anything but `type`, `enabled`, `disabled`, `timeout`, `alwaysLoad`).

Study reads are bounded: Markdown files to 256 KiB; the tree to 1,000 entries, eight levels and a time budget; search to 100 hits, 4 MiB and a time budget. Symlinks, hard links and special files are rejected. Context analysis reads at most 16 MiB of SDK transcript one JSON line at a time (256 KiB per line, 20,000 lines) and returns at most 100 sections and 100 rollups (8,000-character previews); a larger transcript keeps its persisted window reading. One workspace/context inspection runs at a time across browser clients (`429 inspection_busy`, retried by the page); chat stays available. MCP status covers at most 32 live sessions and times out after one second.

## Reconnection and limits

An acknowledgment means the Agent accepted custody; completion is separate. A browser disconnect never cancels accepted work. The daemon retains a bounded mailbox and replay ring across web-process restarts. A replay gap reloads authoritative history. A daemon restart creates a new epoch and invalidates old mutations.

If a response is lost, use **Check message status**. The draft remains available and is never automatically resubmitted. After a daemon crash the outcome can be unknown, even when input appears in history; review the conversation before choosing to send again. Exactly-once execution across daemon crashes is not promised.

Admission limits are 16,000 UTF-16 code units (the textarea's length measure), 128 KiB JSON request bodies, 32 active requests, and 4,096 retained receipts. The byte limit accommodates non-ASCII input and JSON escaping. Oldest settled receipts are evicted at capacity; active turns, including failed deliveries that have not finished, are retained. Duplicate/conflicting IDs are detected while their receipt is retained. An evicted ID reads back as unknown; never retry an old request ID expecting indefinite deduplication. Receipts are also journaled to `~/.tomo/data/web/requests.jsonl` (append-only, `0600`, fsynced before the browser hears "accepted"), so a request ID resent after a restart is still recognised. A request the daemon accepted but never settled before it stopped or crashed is **not re-run**: it reads back as `interrupted`, its recorded bubble (if any) carries an "Interrupted" badge, and the owner's session gets one note on its next turn (the journal records the note as given only after it is written and fsynced to the pending-notes file; a failed write or a crash before that repeats the note on the next start rather than skipping it). Its full text is kept until its message is found in the transcript or the owner resends or dismisses it in the browser (on its pending bubble, or on its history bubble when the transcript has it). Every such request is always in the snapshot, outside the 128-request window. A resend dismisses the original only once the resent text (or an edit that keeps at least half of it) is accepted; clearing the composer cancels it. With 64 such requests (or half the snapshot budget) waiting, new browser messages are refused (`503 interrupted_backlog`) rather than dropping any. If the journal cannot be read, the browser takes no new messages (`503 journal_unavailable`) and the file is never rewritten. A user-directed new submission uses a new ID. Delivery uses a 2 MiB mailbox and 256 KiB maximum events. Oversized or unavailable outlets enter the existing delivery-failure path. The browser is never a prerequisite for Agent progress.

History reads are limited to 100 records per page, 1,024 files / 64 MiB scanned per request, and 2 MiB responses. Malformed cursors return 400; rotation returns 409 and the browser reloads the first page. Scan/response limits return 413; unreadable or ambiguous history remains unavailable. Pages still rescan the bounded history; use the CLI for larger archives.

## Security and operations

The web child generates a random 32-byte token in the runtime home's `web-token` file (normally `~/.tomo/web-token`), with mode `0600`. A valid existing token survives restarts/upgrades. Missing, malformed, symlinked, or incorrectly permissioned files are atomically replaced under the existing file lock; the startup log announces replacement. If the token cannot be safely persisted, the UI fails closed while messaging remains available. Usable access URLs are written to `web-access.log` under the runtime home, atomically replaced at mode `0600`. Ordinary logs redact the recognizable Web token format, including when a tool prints the token file. Keep the private access link file out of bug reports. To rotate access, stop Tomo, remove `web-token`, and restart; existing signed cookies then become invalid.

Bootstrap requires the token or an existing signed cookie. Every other API, including history and SSE, also requires authentication. Cookies are bound to the exact origin, last 30 days, and survive web/daemon restarts when the token is unchanged. HTTPS cookies are Secure. CSRF tokens expire after 12 hours; a definite `invalid_csrf` rejection refreshes bootstrap and retries once with the same request ID and daemon epoch. Network failures and epoch changes never trigger automatic resubmission.

A private token file prevents another OS account, or a sandbox/container without access to that file, from obtaining web access. It cannot stop a process already running as the owner or an environment sharing the owner's files. Exact Host/Origin checks, same-origin Fetch Metadata, a required API header, CSRF, and a restrictive CSP also protect against hostile websites. This requires a browser that sends `Sec-Fetch-Site`; older browsers without Fetch Metadata are rejected. Chromium is covered by the browser E2E suite. Assets are packaged locally; markdown cannot execute HTML/scripts or automatically fetch remote images.

HTTP, asset serving, and history reads run in a supervised process with memory, startup, IPC, and connection limits. A busy port, a crashed process, or a hung startup is retried with capped exponential backoff (up to 5 minutes) for as long as the daemon runs; the failure counter resets after 5 minutes of health. Entering backoff logs an error, and `tomo status` shows the web line (listening, or down with the next retry time and last failure). Messaging channels continue operating. No UI request can call a generic file, command, or Agent RPC.

## Private access through Tailscale Serve

Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) on the same host to terminate HTTPS and forward to loopback:

```sh
tailscale serve --bg http://127.0.0.1:9465
```

Copy the exact HTTPS origin reported by Serve into `web.externalOrigin` and restart Tomo. For example, using a synthetic tailnet name:

```json
{ "web": { "externalOrigin": "https://test-node.test-tailnet.ts.net" } }
```

Use the Tailscale access link from `web-access.log` on a device in that tailnet. Preserve the original Host and Origin through the proxy. The allowlist consists of the exact local origin and this single configured HTTPS `.ts.net` origin; no wildcard, suffix-based request matching, LAN listener, or forwarded-header trust is used. Authentication remains mandatory for both origins, and cookies cannot cross between them. Tailnet access rules should also restrict who can reach the service.

**Never use Tailscale Funnel.** Funnel exposes a service to the public internet; public deployment is unsupported. Tomo does not configure Tailscale or infer whether an operator enabled Funnel. Use Serve restricted to the tailnet and check its configuration. The implementation is tested with equivalent proxy Host/Origin requests; a live tailnet smoke test remains an operator check.

## Development and validation

The UI is React + Tailwind v4 (via `@tailwindcss/vite`) + shadcn/ui (new-york style, Radix primitives, lucide icons). Components live in `web/src/components/ui` (added with the shadcn CLI, imports via the `@/` alias); colours, radius and fonts are shadcn tokens defined in `web/src/styles.css` for light and `.dark`. The app sets `.dark` on `<html>` for an explicit dark theme, or for the system theme while the OS is dark. Keep Radix menus/dialogs non-modal: modal ones inject an inline `<style>` that the CSP blocks.

Type: Tomo's replies and the brand use Source Serif 4 (400/600, self-hosted Latin subset in `web/src/fonts`, SIL OFL; the licence ships in `dist/web-assets/THIRD_PARTY_LICENSES.txt`); everything else — your messages, the UI, small labels and timestamps — uses the system sans. Chinese is always PingFang SC (the serif's `unicode-range` is Latin-only and both stacks name PingFang before any generic). Monospace is kept for code, file paths, config keys, tool calls and their input/output.

```sh
npm ci
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

The browser E2E test uses the real HTTP, CSRF, child-process RPC, router, Agent, delivery pipeline, and session store. Only the external SDK and messaging transport are deterministic test doubles. All runtime paths are temporary; no real account or daemon is used. Browser screenshots are written to the ignored `test-results/` directory. CI runs lint, strict TypeScript, Vitest coverage on the existing Node matrix, and Chromium E2E on Node 24.

`npm run build` includes browser assets in `dist/web-assets`; `npm pack` includes them in the distribution. `npm run dev` serves those built assets, so rebuild after frontend changes. The UI does not start a Vite development server in the daemon.
