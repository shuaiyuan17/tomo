# PR #383 review follow-up

## Required fixes

| Finding | Result | Regression evidence |
| --- | --- | --- |
| Interactive config write collisions | The CLI waits up to one second for the shared lock, keeps the draft on failure, and offers retry. Revision conflicts require a decision before rebasing only the editor's changes onto the latest file. Overlapping fields are named with values hidden; cancellation explicitly discards the action and returns to the menu. Submenu references are kept in sync after a rebase. | `cli-config-concurrency.test.ts`, existing config write-guard and auth tests |
| Whole-entry MCP validation changed startup compatibility | Restore the tolerant runtime parser. Web validation permits unchanged legacy MCP errors, so unrelated saves and incremental repairs work; newly introduced or changed invalid values still fail Zod validation. Repair previews hide malformed values that could contain credentials. | `external-mcp-config.test.ts`, `web-management.test.ts` |
| Restart flag outlived a failed worker | Observe worker exit after spawn acknowledgment and release the daemon's pending flag. Authenticated status polling lets the page offer an explicit retry on the same daemon. Completion still requires a new epoch; no restart is retried automatically. | `web-restart.test.ts`, `web-supervisor.test.ts`, browser restart-failure/retry scenario |
| Cron revisions changed on every run | Hash only task intent. Check it under the existing store lock; starting/completing runs no longer blocks a confirmed disable/delete, while concurrent intent edits still conflict. | `web-inspection.test.ts` |
| Steering eligibility changed during async preparation | Recheck the actual active turn and live audience synchronously inside `LiveSession.steer`, immediately before SDK injection. Ineligible web input falls back to a separate queued send with its own delivery and transcript. | `web-routing.test.ts`: change to background work or group audience after ingress, before dispatch |

## Smaller notes

- Use a small `epoch` RPC for local mutations. The message hot path uses its existing authoritative daemon check and does not request an extra snapshot (`web-control-http.test.ts`).
- Serialize workspace/context inspections across clients while keeping lightweight reads and chat available. Context parsing retains one bounded UTF-8 line at a time rather than a whole-file string, split array and parsed event graph. Cap input at 16 MiB / 20,000 lines / 256 KiB per line and retain 100 bounded summary previews; keep persisted usage available when analysis exceeds a limit (`web-inspection.test.ts`, `web-control-http.test.ts`). Memory search already reads files sequentially with a 4 MiB scan budget; it shares the new concurrency bound.
- TODO discovery deliberately implements the original root-level `memory/TODO*.md` requirement. Nested TODO files remain accessible in Memory; tests pin both behaviors.
- The authenticated owner browser deliberately includes `memory/private/`, independently of the session selected for history. Owner-only file reading/search and API authentication are covered; this does not grant group participants access.
- Restore the data-loss and test-isolation rationale in the config store/helper comments.

No package registry migration is included: the reported registry mirror is pre-existing and unrelated to this PR.

See `web-ui-validation.md` for final checks and implementation-reversion evidence. Tests use synthetic runtime directories and substitute the restart executor; they never restart a user's daemon.
