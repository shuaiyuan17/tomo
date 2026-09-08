# Contributing to Tomo

Tomo is a small personal assistant daemon, maintained mostly by one person and one coding agent. Contributions are welcome, and the bar is the same for everyone: a clear problem statement, a focused diff, and evidence that it works.

## What to send

| You have | Do this |
|---|---|
| A bug with a repro | Open a PR, or a [bug report](https://github.com/shuaiyuan17/tomo/issues/new?template=bug_report.yml) if you cannot fix it |
| A feature or behavior change | Open a [feature request](https://github.com/shuaiyuan17/tomo/issues/new?template=feature_request.yml) first so the shape is agreed before the code |
| Install or config trouble | [Setup help](https://github.com/shuaiyuan17/tomo/issues/new?template=setup_help.yml) |
| A security vulnerability | Private report via [SECURITY.md](SECURITY.md), never a public issue |
| A refactor-only change | Skip it unless it unblocks a concrete fix in the same PR |

Search open and closed issues and PRs before starting. The tracker sometimes lags the code, so also grep the source for the capability you want.

## Development setup

Requires Node 22.12 or newer and a [Claude Code](https://claude.com/claude-code) login for live runs.

```bash
git clone https://github.com/shuaiyuan17/tomo.git && cd tomo
npm install
npm run dev              # tsx watch, foreground with hot reload
```

Before opening a PR:

```bash
npm run lint             # eslint over src/ and tests/
npm run build            # tsc
npm test                 # vitest, full suite
npx vitest run tests/<file>   # one file; shared fixtures live in tests/helpers/
```

CI runs the same three commands on Node 22, 24, and 26. Runtime data (config, sessions, logs, workspace) lives under `~/.tomo/`, so a dev run shares state with an installed Tomo on the same machine; run `tomo backup` first if that matters to you.

## Code conventions

The authoritative reference is [CLAUDE.md](CLAUDE.md), which documents the architecture, the session-key and message-flow invariants, and the rules that are easy to break by accident (JSONL rewrites, harness envelopes, private-memory boundaries). Read the section for the area you are touching. The short version:

- ESM, TypeScript strict, imports end in `.js`, named exports only.
- Log through `log` from `src/logger.ts`.
- Config is zod-validated in `src/config.ts`; a new key needs a schema entry, a README entry, and a test.
- Anything that rewrites a session JSONL file must preserve unparseable lines (see the LCM section of CLAUDE.md).
- Tests live in `tests/` and mirror `src/`. Behavior changes need a test; bug fixes need one that fails before the fix.

## Pull requests

- One concern per PR. Split unrelated changes.
- Fill in the PR template. The **Evidence** section is what gets read first: a focused test, `tomo logs` output, or a redacted chat transcript beats prose.
- Title the PR by the user-visible change, optionally prefixed with an area (`telegram:`, `cron:`, `lcm:`), matching the existing history. Conventional Commits prefixes are fine too; neither is enforced.
- Say which platform you tested on. iMessage paths only run on macOS.
- Update the README for any new config key, CLI flag, or chat command, and CLAUDE.md if you changed an invariant it documents.
- Keep tokens, phone numbers, and chat IDs out of the diff, the description, and test fixtures.
- Leave **Allow edits from maintainers** on so the branch can be finished if you step away.

AI-assisted PRs are welcome with no disclosure label. Make sure you understand what the code does before you ask for review, and answer review comments yourself.

## Reporting bugs

Use the bug form. The fields that matter most are the exact repro, `tomo --version`, the channel, and redacted lines from `tomo logs` (file at `~/.tomo/logs/tomo.log`). A root-cause guess with a file path is a bonus.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
