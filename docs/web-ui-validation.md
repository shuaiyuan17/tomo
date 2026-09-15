# Local web chat: validation evidence

Validated on 2026-09-15 with macOS 26.6.2 (arm64), Node 24.11.1, and Chromium 153 through Playwright 1.63.0. The external SDK and messaging transport are deterministic doubles; HTTP, CSRF, IPC, routing, Agent execution, delivery, and session persistence are real.

## Checks

- `npm run lint` — passed.
- `npm run build` — strict backend and frontend TypeScript, plus packaged Vite assets, passed.
- `npm run test:coverage -- --maxWorkers=4` — 2,587 tests in 139 files passed.
- `npm run test:e2e` — 3 Chromium chat scenarios passed: normal chat/history/group read-only behavior, uncertain-response recovery without resubmission, and provider operation after web-process failure.
- `npm run test:web:mutations` — 28 targeted implementation reversions produced behavioral test failures; restored backend and browser suites passed. Compilation/import failures do not count.
- `npm pack` followed by installation into a disposable directory — installed web process returned HTTP 200 for its page, JavaScript, and CSS without source-checkout dependencies.
- `git diff --check` — passed.

CI runs the existing Node 22.12 / 24 / 26 matrix and browser tests on Node 24. Consult the pull request's checks for remote results; the evidence above records local validation.

## Browser acceptance

Tested at 1440 × 900 (dark) and 768 × 1024 (light), with actual screenshots inspected. Verified bounded conversation layout without horizontal overflow, reachable composer/session/theme controls, safe Markdown, disabled read-only group input, Enter submission, checked/unchecked task rendering, reconnect state, and preserved uncertain drafts. Screenshots and raw test logs remain in ignored `test-results/` and are available as CI artifacts; fixtures contain only synthetic content.

The transcript remains the source record rather than a delivery receipt: existing raw-response/NO_REPLY semantics are retained. Current request status indicates delivery failure separately. No real daemon, credentials, or chat data were used.

## Reversion matrix

The runner copies the working tree into a temporary directory, keeps tests unchanged, mutates one implementation behavior, checks for a meaningful assertion failure, restores the file, and finally reruns the baseline and browser suite. It deletes the temporary copy afterward and writes machine-readable results and logs under `test-results/mutations/`.

| Reverted behavior | Unchanged test | Evidence |
| --- | --- | --- |
| `enabled-default` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `unique-owner` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `owner-dm-routing` | `tests/web-routing.test.ts` | Failed on behavior; passed after restore |
| `group-channel-denial` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `group-router-denial` | `tests/web-routing.test.ts` | Failed on behavior; passed after restore |
| `provider-web-steering` | `tests/web-routing.test.ts` | Failed on behavior; passed after restore |
| `request-deduplication` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `completed-block-stream` | `tests/web-routing.test.ts` | Failed on behavior; passed after restore |
| `mailbox-limit` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `ingress-close` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `safe-tool-activity` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `event-replay` | `tests/web-channel.test.ts` | Failed on behavior; passed after restore |
| `host-validation` | `tests/web-http.test.ts` | Failed on behavior; passed after restore |
| `origin-validation` | `tests/web-http.test.ts` | Failed on behavior; passed after restore |
| `csrf-validation` | `tests/web-http.test.ts` | Failed on behavior; passed after restore |
| `read-only-sessions` | `tests/web-history.test.ts` | Failed on behavior; passed after restore |
| `sidecar-history` | `tests/web-history.test.ts` | Failed on behavior; passed after restore |
| `estimated-context` | `tests/web-history.test.ts` | Failed on behavior; passed after restore |
| `child-restart` | `tests/web-supervisor.test.ts` | Failed on behavior; passed after restore |
| `stale-epoch` | `tests/web-supervisor.test.ts` | Failed on behavior; passed after restore |
| `hung-process-watchdog` | `tests/web-supervisor.test.ts` | Failed on behavior; passed after restore |
| `queued-refusal` | `tests/web-routing.test.ts` | Failed on behavior; passed after restore |
| `automatic-start` | `tests/web-startup.test.ts` | Failed on behavior; passed after restore |
| `disable-ui` | `tests/web-startup.test.ts` | Failed on behavior; passed after restore |
| `messaging-requirement` | `tests/web-startup.test.ts` | Failed on behavior; passed after restore |
| `group-composer` | `e2e` | Failed on behavior; passed after restore |
| `theme-choice` | `e2e` | Failed on behavior; passed after restore |
| `uncertain-draft` | `e2e` | Failed on behavior; passed after restore |

An initial interleaving test checked only final recipients and survived removal of the steering guard. It was strengthened to assert that incompatible input stays out of the active transcript until the current turn completes; the guard reversion now fails. This prevents passing evidence from a test that never exercised the intended protection.

The full-suite run also exposed an existing LCM fixture that encoded local calendar days as UTC timestamps. The fixture now constructs local dates, preserving the same rollup assertions across host time zones; production LCM behavior is unchanged.
