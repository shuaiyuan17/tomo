# Local web chat

`tomo start` starts the optional web UI on **127.0.0.1:9465**. Open the private access link shown in the startup log (`tomo logs`); it includes `?t=<token>`. The page removes this parameter from the address bar and uses an HttpOnly cookie thereafter. At least one existing messaging channel must still be configured.

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

- Owner messages use the existing DM session, Agent queue, SDK, delivery filters, and transcript. Replies from browser input go to the browser. Messaging channels and scheduled notifications retain their normal destinations.
- Groups are read-only: select a group to inspect its history and recorded context use. Browser group writes are refused by both the HTTP service and daemon.
- Replies appear one completed content block at a time. Tool activity shows names and status from attributed watch events; tool arguments and results are omitted.
- History is the canonical transcript, including recorded replies that may have been silent or failed delivery. It is not a read receipt. Existing transcript policies are preserved. The current request status separately reports web delivery failure.
- Context uses the same persisted `contextUsed` / `contextMax` values as the CLI. Estimated values are labeled. A missing window is unavailable.

The first implementation includes chat, history, and the recorded context meter. TODOs, cron, memory, detailed context history, MCP, and config editing follow in separate PRs.

## Reconnection and limits

An acknowledgment means the Agent accepted custody; completion is separate. A browser disconnect never cancels accepted work. The daemon retains a bounded mailbox and replay ring across web-process restarts. A replay gap reloads authoritative history. A daemon restart creates a new epoch and invalidates old mutations.

If a response is lost, use **Check message status**. The draft remains available and is never automatically resubmitted. After a daemon crash the outcome can be unknown, even when input appears in history; review the conversation before choosing to send again. Exactly-once execution across daemon crashes is not promised.

Admission limits are 16,000 UTF-16 code units (the textarea's length measure), 128 KiB JSON request bodies, 32 active requests, and 4,096 retained receipts. The byte limit accommodates non-ASCII input and JSON escaping. Oldest settled receipts are evicted at capacity; active turns, including failed deliveries that have not finished, are retained. Duplicate/conflicting IDs are detected while their receipt is retained. An evicted ID reads back as unknown; never retry an old request ID expecting indefinite deduplication. A user-directed new submission uses a new ID. Delivery uses a 2 MiB mailbox and 256 KiB maximum events. Oversized or unavailable outlets enter the existing delivery-failure path. The browser is never a prerequisite for Agent progress.

History reads are limited to 100 records per page, 1,024 files / 64 MiB scanned per request, and 2 MiB responses. Malformed cursors return 400; rotation returns 409 and the browser reloads the first page. Scan/response limits return 413; unreadable or ambiguous history remains unavailable. Pages still rescan the bounded history; use the CLI for larger archives.

## Security and operations

The web child generates a random 32-byte token in the runtime home's `web-token` file (normally `~/.tomo/web-token`), with mode `0600`. A valid existing token survives restarts/upgrades. Missing, malformed, symlinked, or incorrectly permissioned files are atomically replaced under the existing file lock; the startup log announces replacement. If the token cannot be safely persisted, the UI fails closed while messaging remains available. Keep the access link and logs private. To rotate access, stop Tomo, remove `web-token`, and restart; existing signed cookies then become invalid.

Bootstrap requires the token or an existing signed cookie. Every other API, including history and SSE, also requires authentication. Cookies are bound to the exact origin, last 30 days, and survive web/daemon restarts when the token is unchanged. HTTPS cookies are Secure. CSRF tokens expire after 12 hours; a definite `invalid_csrf` rejection refreshes bootstrap and retries once with the same request ID and daemon epoch. Network failures and epoch changes never trigger automatic resubmission.

A private token file prevents another OS account, or a sandbox/container without access to that file, from obtaining web access. It cannot stop a process already running as the owner or an environment sharing the owner's files. Exact Host/Origin checks, same-origin Fetch Metadata, a required API header, CSRF, and a restrictive CSP also protect against hostile websites. This requires a browser that sends `Sec-Fetch-Site`; older browsers without Fetch Metadata are rejected. Chromium is covered by the browser E2E suite. Assets are packaged locally; markdown cannot execute HTML/scripts or automatically fetch remote images.

HTTP, asset serving, and history reads run in a supervised process with memory, startup, IPC, and connection limits. A busy port disables the UI with an actionable diagnostic. A crashed or hung process gets three bounded retries; repeated failures disable it until restart. Messaging channels continue operating. No UI request can call a generic file, command, or Agent RPC.

## Private access through Tailscale Serve

Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) on the same host to terminate HTTPS and forward to loopback:

```sh
tailscale serve --bg http://127.0.0.1:9465
```

Copy the exact HTTPS origin reported by Serve into `web.externalOrigin` and restart Tomo. For example, using a synthetic tailnet name:

```json
{ "web": { "externalOrigin": "https://test-node.test-tailnet.ts.net" } }
```

Use the Tailscale access link from the startup log on a device in that tailnet. Preserve the original Host and Origin through the proxy. The allowlist consists of the exact local origin and this single configured HTTPS `.ts.net` origin; no wildcard, suffix-based request matching, LAN listener, or forwarded-header trust is used. Authentication remains mandatory for both origins, and cookies cannot cross between them. Tailnet access rules should also restrict who can reach the service.

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
