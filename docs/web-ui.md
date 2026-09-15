# Local web chat

`tomo start` starts the optional web UI at **http://127.0.0.1:9465**. Use that exact address; `localhost`, LAN addresses, forwarding proxies, and cross-origin requests are intentionally refused. At least one existing messaging channel must still be configured.

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

Admission limits are 16,000 text characters / 32 KiB request bodies, 32 active requests, and 4,096 request receipts per daemon lifetime. Conflicting reuse of a request ID is refused. Once receipt capacity is reached, restart Tomo. Delivery uses a 2 MiB mailbox and 256 KiB maximum events. Oversized or unavailable outlets enter the existing delivery-failure path. The browser is never a prerequisite for Agent progress.

History reads are limited to 100 records per page, 1,024 files / 64 MiB scanned per request, and 2 MiB responses. Exceeding a limit or encountering unreadable/ambiguous history produces an unavailable state rather than silently returning an empty history. Use the CLI for larger archives in this initial version.

## Security and operations

There is no login. This service trusts local processes and the local OS account; loopback is not OS-user authentication. Exact Host/Origin checks, same-origin fetch metadata, a required API header, cookie-bound CSRF capabilities, and a restrictive CSP protect against hostile websites. Assets are packaged locally; markdown cannot execute HTML/scripts or automatically fetch remote images.

HTTP, asset serving, and history reads run in a supervised process with memory, startup, IPC, and connection limits. A busy port disables the UI with an actionable diagnostic. A crashed or hung process gets three bounded retries; repeated failures disable it until restart. Messaging channels continue operating. No UI request can call a generic file, command, or Agent RPC.

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
