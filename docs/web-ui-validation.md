# Complete web UI: validation evidence

Validated on 2026-09-16 with macOS 26.6.2 (arm64), Node 24.11.1, and Chromium 153 through Playwright 1.63.0. The external SDK and messaging transport are deterministic doubles; HTTP, CSRF, IPC, routing, Agent execution, delivery, and session persistence are real.

## Checks

- `npm run lint` — passed.
- `npm run build` — strict backend and frontend TypeScript, plus packaged Vite assets, passed.
- `npm run test:coverage -- --maxWorkers=4` — 2,650 tests in 145 files passed.
- `npm run test:e2e` — 15 Chromium scenarios passed: chat/history/groups, token/CSRF, long input, recovery, queued bubbles, live web/provider steering, TODO/memory/context, confirmed cron/config/MCP changes, mobile controls and restart/reconnection.
- `npm run test:web:mutations` plus targeted follow-up runs — 85 distinct implementation reversions produced behavioral failures; restored backend/browser suites passed. Compilation/import failures do not count. The complete 82-case run was followed by six affected steering checks (including the new system-turn guard), then three mailbox checks (including two new pending-text behaviors). All 85 cases are now available through the same runner.
- `npm pack` followed by installation into a disposable directory — installed web process returned HTTP 200 for its page, JavaScript, and CSS without source-checkout dependencies; unauthenticated bootstrap returned 401, token bootstrap returned 200, and react-dom/react-markdown/remark-gfm were absent from the production installation.
- `git diff --check` — passed.

CI runs the existing Node 22.12 / 24 / 26 matrix and browser tests on Node 24. Consult the pull request's checks for remote results; the evidence above records local validation.

## Browser acceptance

Tested at 1440 × 900 (light/dark), 768 × 1024 (light), and 390 × 844 (dark), with actual screenshots inspected. Verified bounded conversation layout without horizontal overflow, reachable composer/session/theme controls, safe Markdown, disabled read-only group input, Enter submission, checked/unchecked task rendering, reconnect state, and preserved uncertain drafts. Study checks cover real file search, disabled checkbox state, secret-safe review dialogs, confirmation cancellation, Escape/focus restoration, saved/running state, mobile controls, and waiting for a new epoch before reporting restart complete. Screenshots and raw test logs remain in ignored `test-results/` and are available as CI artifacts; fixtures contain only synthetic content.

The transcript remains the source record rather than a delivery receipt: existing raw-response/NO_REPLY semantics are retained. Current request status indicates delivery failure separately. No real daemon, credentials, or chat data were used.

## Reversion matrix

The runner copies the working tree into a temporary directory, keeps tests unchanged, mutates one implementation behavior, checks for a meaningful assertion failure, restores the file, and finally reruns the baseline and browser suite. It deletes the temporary copy afterward and writes machine-readable results and logs under `test-results/mutations/`.

| Reverted behavior | Unchanged test | Evidence |
| --- | --- | --- |
| `accepted-bubble` | `e2e` | Behavioral failure; restored pass |
| `pending-reload` | `e2e` | Behavioral failure; restored pass |
| `web-live-steering` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `joined-correlation` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `joined-mirror` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `canonical-reply-once` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `todo-discovery` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `memory-path` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `memory-hardlinks` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `memory-size` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `memory-search` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `cron-list` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `cron-revision` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `cron-confirmation` | `tests/web-control-http.test.ts` | Behavioral failure; restored pass |
| `context-usage` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `context-estimator` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `context-rollups` | `tests/web-inspection.test.ts` | Behavioral failure; restored pass |
| `config-lock` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `config-fail-fast` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `config-revision` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `config-schema` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `config-opaque-values` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `config-secret-diff` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `preview-browser` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `preview-expiry` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `mcp-legacy-config` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `mcp-actual-health` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `mcp-hung-query` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `restart-arguments` | `tests/web-management.test.ts` | Behavioral failure; restored pass |
| `restart-once` | `tests/web-supervisor.test.ts` | Behavioral failure; restored pass |
| `management-csrf` | `tests/web-control-http.test.ts` | Behavioral failure; restored pass |
| `management-epoch` | `tests/web-control-http.test.ts` | Behavioral failure; restored pass |
| `todo-checkbox` | `e2e` | Behavioral failure; restored pass |
| `config-diff-ui` | `e2e` | Behavioral failure; restored pass |
| `restart-epoch-ui` | `e2e` | Behavioral failure; restored pass |
| `access-log-permissions` | `tests/web-access.test.ts` | Behavioral failure; restored pass |
| `web-token-redaction` | `tests/web-access.test.ts` | Behavioral failure; restored pass |
| `unicode-body-limit` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `csrf-recovery` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `private-api-auth` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `bootstrap-auth` | `tests/web-access.test.ts` | Behavioral failure; restored pass |
| `secure-cookie` | `tests/web-access.test.ts` | Behavioral failure; restored pass |
| `token-private-mode` | `tests/web-access.test.ts` | Behavioral failure; restored pass |
| `token-reuse` | `tests/web-access.test.ts` | Behavioral failure; restored pass |
| `tailnet-allowlist` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `receipt-eviction` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `active-receipts` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `history-status` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `config-diagnostic` | `tests/web-config.test.ts` | Behavioral failure; restored pass |
| `supervisor-stop-start` | `tests/web-supervisor.test.ts` | Behavioral failure; restored pass |
| `transient-replay` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `url-token-removal` | `e2e` | Behavioral failure; restored pass |
| `oversize-feedback` | `e2e` | Behavioral failure; restored pass |
| `history-recovery` | `e2e` | Behavioral failure; restored pass |
| `enabled-default` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `unique-owner` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `owner-dm-routing` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `group-channel-denial` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `group-router-denial` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `provider-web-steering` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `request-deduplication` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `completed-block-stream` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `mailbox-limit` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `ingress-close` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `safe-tool-activity` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `event-replay` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `host-validation` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `origin-validation` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `csrf-validation` | `tests/web-http.test.ts` | Behavioral failure; restored pass |
| `read-only-sessions` | `tests/web-history.test.ts` | Behavioral failure; restored pass |
| `sidecar-history` | `tests/web-history.test.ts` | Behavioral failure; restored pass |
| `estimated-context` | `tests/web-history.test.ts` | Behavioral failure; restored pass |
| `child-restart` | `tests/web-supervisor.test.ts` | Behavioral failure; restored pass |
| `stale-epoch` | `tests/web-supervisor.test.ts` | Behavioral failure; restored pass |
| `hung-process-watchdog` | `tests/web-supervisor.test.ts` | Behavioral failure; restored pass |
| `queued-refusal` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |
| `automatic-start` | `tests/web-startup.test.ts` | Behavioral failure; restored pass |
| `disable-ui` | `tests/web-startup.test.ts` | Behavioral failure; restored pass |
| `messaging-requirement` | `tests/web-startup.test.ts` | Behavioral failure; restored pass |
| `group-composer` | `e2e` | Behavioral failure; restored pass |
| `theme-choice` | `e2e` | Behavioral failure; restored pass |
| `uncertain-draft` | `e2e` | Behavioral failure; restored pass |
| `pending-text-budget` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `terminal-text-release` | `tests/web-channel.test.ts` | Behavioral failure; restored pass |
| `system-turn-steering-guard` | `tests/web-routing.test.ts` | Behavioral failure; restored pass |

An initial interleaving test checked only final recipients and survived removal of the steering guard. It was strengthened to assert that incompatible input stays out of the active transcript until the current turn completes; the guard reversion now fails. This prevents passing evidence from a test that never exercised the intended protection.

The full-suite run also exposed an existing LCM fixture that encoded local calendar days as UTC timestamps. The fixture now constructs local dates, preserving the same rollup assertions across host time zones; production LCM behavior is unchanged.

The initial stale-cursor browser test could pass because a scheduled snapshot refresh masked the missing recovery handler. It now waits for that initial refresh and introduces rotation only after the cursor request is captured, explicitly asserting a 409 response. Reverting recovery now fails. The CSRF and receipt-capacity checks explicitly assert promise success so runtime rejection counts as behavioral assertion evidence.

Tailscale coverage exercises an exact HTTPS Host/Origin pair through the real loopback HTTP service, including secure cookie issuance, authenticated mutation, and hostile alternate authorities. No live Tailscale account or network was configured; the operator should verify Serve on their own tailnet.

Full-suite validation selected the installed Command Line Tools using `DEVELOPER_DIR=/Library/Developer/CommandLineTools`; the host-selected Xcode app required license confirmation and could not run the existing git/python sandbox tests. No system selection or license acceptance was changed. Private access-log permissions and ordinary-log token redaction are covered by two additional behavioral reversions.

Completion checks were strengthened where an initial reversion survived: merged-turn transcript ownership now exercises an SDK failure after partial delivery, and the daemon epoch guard is checked independently over child IPC (the HTTP guard otherwise masks its removal). The legacy MCP check explicitly asserts successful preview. The final steering guard inspects the actual current SDK turn, including when a provider correction already joined background work. Pending-text checks use escaped control characters to exercise serialized IPC bytes.
