<!--
PR title: describe the user-visible change, not the code change.
  good: telegram: group replies stop after the first @mention
  good: Warn before replacing an existing rollup block
  weak: fix null check in group handler

Link context with a visible line below when it exists:
  Closes #123   or   Related: #123

AI-assisted PRs are welcome and held to the same bar. No disclosure label needed;
the Evidence section is what reviewers read first.
-->

## What problem this solves

<!--
The concrete user or operational problem. For fixes, start with
"Fixes an issue where <doing X> would <Y> when <condition>." Name the channel or
workflow affected. Keep the code-level cause for the next section.
-->

## Why this change

<!--
One or two sentences on the shipped solution, key decisions, and non-goals.
Skip file-by-file narration; the diff already shows that.
-->

## User impact

<!--
What a Tomo user can now do or expect. Say "none" if there is no user-visible change
(refactor, tests, deps). Call out any config key, chat command, or default that changed.
-->

## Evidence

<!--
How you know it works. Focused tests, `tomo logs` output, a chat transcript,
before/after screenshots, or a redacted config. Running the suite alone is fine for a
pure refactor but not for a behavior change.
-->

- Tested on: <!-- macOS 15.x / Ubuntu 24.04 / ... ; iMessage paths need a Mac -->

## Checklist

- [ ] `npm run lint && npm run build && npm test` pass locally
- [ ] Tests added or updated for behavior changes (required for bug fixes)
- [ ] README updated for any new or changed config key, CLI flag, or chat command, or N/A
- [ ] `CLAUDE.md` updated if an architectural invariant changed, or N/A
- [ ] Nothing in the diff or this description contains a token, key, phone number, or chat ID
