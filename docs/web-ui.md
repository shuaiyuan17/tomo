# Local web UI

`tomo start` starts the optional web UI on **127.0.0.1:9465**. Read the private access link with `cat ~/.tomo/web-access.log`; it includes `?t=<token>`. The page removes this parameter from the address bar and uses an HttpOnly cookie thereafter. At least one existing messaging channel must still be configured.

```json
{
  "web": {
    "enabled": true,
    "port": 9465,
    "ownerIdentity": "owner"
  }
}
```

`owner` above is a synthetic identity name: replace it with a configured identity. Omit `ownerIdentity` when exactly one identity exists. With multiple identities, chat remains disabled until a unique owner is selected and Tomo restarts. Set `enabled` to `false` to disable the UI. Invalid web settings disable only the UI and emit a diagnostic.

## Conversations

- Owner messages use the existing DM session, SDK, delivery filters, and transcript. Replies from browser input go to the browser. Messaging channels and scheduled notifications retain their normal destinations.
- Groups are read-only: select a group to inspect its history and recorded context use. Browser group writes are refused by both the HTTP service and daemon.
- Replies appear one completed content block at a time. Tool activity shows names and status from attributed watch events; tool arguments and results are omitted.
- History is the canonical transcript, including recorded replies that may have been silent or failed delivery. It is not a read receipt. Existing transcript policies are preserved. The current request status separately reports web delivery failure.
- Context uses the same persisted `contextUsed` / `contextMax` values as the CLI. Estimated values are labeled. A missing window is unavailable.

## The Study

- **TODOs:** read root-level workspace `memory/TODO*.md` files (nested TODO files remain available in Memory) with checked/unchecked state. Changes are made by the agent in memory; the viewer is read-only.
- **Cron:** inspect names, schedules, next/last runs, status, target sessions, and message bodies. Enable, disable, or delete after reviewing a confirmation. A concurrent run/update invalidates stale confirmations. In-flight work continues; enabling an overdue one-shot schedules it for the next poll.
- **Memory:** browse `MEMORY.md`, topic files, and subdirectories; search literal text and open results. Markdown is read-only. Missing, unreadable, and truncated results have distinct states.
- **Context:** select the owner DM or a group to inspect persisted window usage, the same estimated composition as `tomo lcm stats`, retained rollup blocks from `tomo lcm blocks`, and recent compaction watch events. The latter is bounded to this daemon run, not a complete audit log. Missing window usage is unavailable, not zero.
- **MCP servers:** list all saved definitions, including disabled servers, alongside the actual states reported by active SDK queries. No active query means unknown health. Add/edit/remove/enable/disable creates a reviewed config proposal. Credentials, commands, args, URLs, env, headers, OAuth and unknown fields remain opaque and replacement-only. Editing does not connect a server or start an OAuth flow.
- **Config:** the field metadata and validation reuse the existing Zod schemas. Preview the before/after diff, then save that exact proposal. Existing secrets and opaque collections show only Set/Unset; leave them unchanged to preserve them. Submitted replacements are never echoed in the diff or response. Environment overrides and available running values are labeled separately from saved values.

Config proposals are browser-bound, expire after five minutes, and are limited to 16 outstanding proposals. Saving checks the original revision inside the common config lock, backs up only a readable original, and atomically writes mode `0600`. CLI and daemon writers use the same store. Raw placeholders and unknown fields are preserved. A stale proposal requires reloading and reviewing again.

Saved MCP/config changes show **Restart required**. The confirmed restart button passes your reason to the existing `tomo restart --reason` path; it reports completion only after connecting to a new daemon epoch. Changing the web port/origin or disabling the UI may require opening a new private link or re-enabling it from the CLI. A lost response is not retried automatically. If the restart worker exits while the same daemon is still serving, its pending state is cleared and the page offers an explicit retry; it never treats worker spawn as restart completion.

### Messages during an active turn

An accepted message appears immediately with its request ID and state, including when queued. Its temporary bubble is replaced by the canonical transcript entry without duplication; active queued text survives a web-process restart or page reload.

With steering enabled, owner browser input joins a busy private user turn through the SDK's existing input stream. The request is marked joined only when the SDK echoes that input. The original turn writes the shared reply once. A joined browser receives completed blocks through the normal delivery pipeline; when the original turn is on a messaging channel, that channel retains its reply too. Multiple joined browser requests share one web stream. If the SDK promotes the input to a follow-up turn, it gets its own ordinary reply.

Input stays queued when steering is disabled, or the active work is background/system work or has a group audience. Provider input arriving during a web turn also retains its existing destination guard. Group sessions remain read-only in the browser. Partial failure preserves the canonical transcript and settles the joined request without replaying the turn.

## Reconnection and limits

An acknowledgment means the Agent accepted custody; completion is separate. A browser disconnect never cancels accepted work. The daemon retains a bounded mailbox and replay ring across web-process restarts. A replay gap reloads authoritative history. A daemon restart creates a new epoch and invalidates old mutations.

If a response is lost, use **Check message status**. The draft remains available and is never automatically resubmitted. After a daemon crash the outcome can be unknown, even when input appears in history; review the conversation before choosing to send again. Exactly-once execution across daemon crashes is not promised.

Admission limits are 16,000 UTF-16 code units (the textarea's length measure), 128 KiB JSON request bodies, 32 active requests, and 4,096 retained receipts. The byte limit accommodates non-ASCII input and JSON escaping. Oldest settled receipts are evicted at capacity; active turns, including failed deliveries that have not finished, are retained. Duplicate/conflicting IDs are detected while their receipt is retained. An evicted ID reads back as unknown; never retry an old request ID expecting indefinite deduplication. A user-directed new submission uses a new ID. Queued message text and completed blocks share a 2 MiB serialized snapshot budget (with metadata headroom), so large valid inputs cannot overflow child IPC. Text is released at terminal settlement, including refused handoffs. Delivery uses 256 KiB maximum events. Oversized or unavailable outlets enter the existing delivery-failure path. The browser is never a prerequisite for Agent progress.

History reads are limited to 100 records per page, 1,024 files / 64 MiB scanned per request, and 2 MiB responses. Malformed cursors return 400; rotation returns 409 and the browser reloads the first page. Scan/response limits return 413; unreadable or ambiguous history remains unavailable. Pages still rescan the bounded history; use the CLI for larger archives.

Study reads are bounded: Markdown files to 256 KiB; tree traversal to 1,000 entries, eight subdirectories and a time budget; search to 100 hits, 4 MiB and a time budget. Symlinks, hard links and special files are rejected. SDK context analysis reads up to 16 MiB, parses one bounded JSON line at a time (256 KiB per line, 20,000 lines), and returns at most 100 sections/summaries, with 8,000-character summary previews. Only one workspace/context inspection runs at a time across browser clients; overlapping inspections receive `429 inspection_busy`, while chat and lightweight reads remain available. Larger transcripts retain their persisted window reading. MCP status polls active queries every 15 seconds, limits reads to 32 sessions and 128 servers per query, and times out after one second without accumulating hung requests.

## Security and operations

The web child generates a random 32-byte token in the runtime home's `web-token` file (normally `~/.tomo/web-token`), with mode `0600`. A valid existing token survives restarts/upgrades. Missing, malformed, symlinked, or incorrectly permissioned files are atomically replaced under the existing file lock; the startup log announces replacement. If the token cannot be safely persisted, the UI fails closed while messaging remains available. Usable access URLs are written to `web-access.log` under the runtime home, atomically replaced at mode `0600`. Ordinary logs redact the recognizable Web token format, including when a tool prints the token file. Keep the private access link file out of bug reports. To rotate access, stop Tomo, remove `web-token`, and restart; existing signed cookies then become invalid.

Bootstrap requires the token or an existing signed cookie. Every other API, including history and SSE, also requires authentication. Cookies are bound to the exact origin, last 30 days, and survive web/daemon restarts when the token is unchanged. HTTPS cookies are Secure. CSRF tokens expire after 12 hours; a definite `invalid_csrf` rejection refreshes bootstrap and retries once with the same request ID and daemon epoch. Network failures and epoch changes never trigger automatic resubmission.

A private token file prevents another OS account, or a sandbox/container without access to that file, from obtaining web access. It cannot stop a process already running as the owner or an environment sharing the owner's files. Exact Host/Origin checks, same-origin Fetch Metadata, a required API header, CSRF, and a restrictive CSP also protect against hostile websites. This requires a browser that sends `Sec-Fetch-Site`; older browsers without Fetch Metadata are rejected. Chromium is covered by the browser E2E suite. Assets are packaged locally; markdown cannot execute HTML/scripts or automatically fetch remote images.

HTTP, asset serving, workspace reads, context analysis, and config/cron operations run in a supervised process with memory, startup, IPC, and connection limits. A busy port disables the UI with an actionable diagnostic. A crashed or hung process gets three bounded retries; repeated failures disable it until restart. Messaging channels continue operating. No UI request can call a generic file, command, or Agent RPC. The restart operation dispatches only the installed restart command. Daemon config writers fail promptly on lock contention; the separate web and interactive CLI processes may wait up to one second. The CLI retains its draft on a lock timeout and offers retry; a changed revision requires confirmation before applying only the draft’s changed fields onto the latest config. Overlapping fields are named without showing values, and discarding the draft is explicit.

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

### Read and edit compatibility

The authenticated browser is the owner's administrative surface, including when it displays a read-only group session. Memory therefore deliberately includes `memory/private/`; selecting a group session does not delegate browser access to group participants. Root-level TODO discovery, private-file viewing/search, and authentication are pinned by tests.

Cron confirmations compare intent fields (ID, name, schedule, message, target session, enabled state, delete-after-run). Scheduler bookkeeping does not invalidate a confirmation, so a frequently running job can still be disabled. Concurrent edits to its configuration remain protected by the existing locked store.

Runtime MCP parsing retains its tolerant behavior for optional legacy values. Web saves preserve unchanged legacy validation errors, allowing unrelated changes and incremental repairs; new or changed invalid values are rejected by the shared Zod schema. Repair previews continue to hide credential-bearing or malformed values.
