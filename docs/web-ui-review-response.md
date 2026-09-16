# PR 380 review follow-up

The 2026-09-16 review decisions include token authentication and private Tailscale access. These replace the original no-login requirement. Owner DM routing, read-only groups, completed-block streaming, and the messaging-channel startup requirement remain unchanged.

| Finding | Resolution and evidence |
| --- | --- |
| 1. Text/body limits | The JSON limit is 128 KiB, covering 16,000 UTF-16 units even when JSON escapes each as six bytes. HTTP tests cover CJK, emoji, and escaped control characters; browser E2E round-trips 16,000 CJK characters. A 413 now asks the user to shorten the preserved draft. |
| 2. Expired CSRF | A definite `invalid_csrf` response refreshes bootstrap and retries exactly once with the same ID and epoch. Login cookies last independently of CSRF and survive child restarts. A real HTTP test advances an injected clock past 12 hours; browser E2E verifies single retry and single Agent execution. Network failures and epoch changes do not retry. |
| 3a. Authentication | A private, locked, atomically written `web-token` survives restarts. Bootstrap requires the token or a signed cookie; all other API reads, SSE, and writes require authentication too. Gating bootstrap alone would leave the existing GET endpoints exposed. Cookies bind to the exact origin; HTTPS cookies are Secure. Unsafe/unwritable token storage cannot start the UI and cannot block messaging. |
| 3b. Tailscale | The supported topology is same-host Tailscale Serve forwarding HTTPS to the unchanged loopback listener. `web.externalOrigin` adds one exact HTTPS `.ts.net` origin. Token authentication is always required; Host/Origin pairs use exact equality and forwarding identity headers grant no privileges. Funnel/public deployment is explicitly unsupported. Integration tests exercise proxy-equivalent headers; a live tailnet was not configured. |
| 4. Dependencies | `react-dom`, `react-markdown`, and `remark-gfm` moved to devDependencies. React remains a runtime dependency with `^19.3.0`, satisfying Ink's `>=19.2.0` peer range. A disposable production-only install verifies the three browser packages are absent and packaged assets/authentication work. |
| 5. Config diagnostics | Invalid optional web settings use the existing warning logger, remain nonblocking, and never reflect the invalid value. An isolated config test checks all three behaviors. |
| 6. Receipt capacity | At 4,096 retained receipts, evict the oldest settled receipt. The 32-active limit counts unsettled failed deliveries too. A 4,101-submission test proves continued admission and preservation of a live outlet. Lookup of an evicted ID returns unknown without scanning history. Deduplication is bounded by retained receipts, as documented; the browser never automatically resubmits unknown work. |
| 7. History errors | Typed history errors map malformed cursors to 400, revision changes to 409, and resource limits to 413. Browser E2E introduces rotation during the cursor request and verifies first-page recovery without an error prompt. |

## Other comments

- SSE sends the authoritative snapshot first, replays only transient tool/typing activity, then sends buffered events newer than its watermark. Old block replay cannot resurrect completed work.
- Browser Fetch Metadata support is documented.
- Stop/start clears the supervisor's completed startup promise and is tested with real child processes.
- Unknown request lookup no longer scans a transcript merely to return unknown.
- History maintains its 101-record tail by bounded binary insertion; the documented full-scan-per-page limit remains.
- The retained LCM test-only local-day fixture correction is called out in the follow-up commit and PR description.
- The CodeQL finding in the E2E fixture now uses parsed hostname equality instead of URL-prefix matching.

## Validation

Lint and strict TypeScript build pass. All 2,611 tests in 142 files pass; all 8 Chromium E2E scenarios pass. Each of 45 targeted implementation reversions fails a behavioral assertion, and the restored suites pass. See [validation evidence](web-ui-validation.md) for the matrix and packaging check. Remote results are recorded in the PR checks.
