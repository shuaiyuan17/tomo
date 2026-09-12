# Security Policy

## Reporting a vulnerability

Report privately through a [GitHub Security Advisory](https://github.com/shuaiyuan17/tomo/security/advisories/new). Do not open a public issue or PR that discloses an unpatched vulnerability, exploit path, or secret. Public reports of that kind will be closed and redirected here.

Tomo does not run a bug bounty. Reports are handled on a best-effort basis by a single maintainer; expect an acknowledgement within a week.

A useful report includes:

- What you found and which trust boundary below it crosses.
- The affected component, `tomo --version` or commit SHA, OS, and Node version.
- Reproduction steps against `main` or the latest npm release.
- The actual impact, and a focused patch if you have one.

Reports without a reproduction and a demonstrated boundary crossing are deprioritized.

## Trust model

Tomo is a single-user daemon on a machine the user owns. It runs the Claude Agent SDK with permissions bypassed, so the model can already do most of what the logged-in user can. The boundaries Tomo enforces are the ones below.

**Trusted**

- The user who installed Tomo, and every process on that machine.
- `~/.tomo/config.json` and the workspace files under `~/.tomo/workspace/`. Whoever can write them controls the assistant.
- External MCP servers and Claude Code plugins the user configured. Enabling one is a trust decision.

**Untrusted**

- Every inbound message, from any channel, including messages from allowlisted senders and group participants.
- Attachments and their metadata.
- Web content and tool results the model reads.

**Boundaries Tomo enforces**

| Boundary | Where |
|---|---|
| Per-channel sender allowlists, checked before any attachment is downloaded or any turn runs | `src/router.ts`, channel adapters |
| Private memory (`memory/private/`) never enters a group flow: excluded from group prompts and tools, file reads denied by hook, Bash run under a `sandbox-exec` profile that denies the directory in the kernel (and withheld outright if that sandbox cannot be set up), `MEDIA:` attachments of private paths dropped before send | `src/agent/permissions.ts`, `src/agent/bash-sandbox.ts`, `src/agent/delivery-pipeline.ts` |
| Per-agent permission scoping (`agentProfiles`): write fences, secret paths, Bash modes, enforced by a `PreToolUse` hook that a bypass-permissions session cannot skip | `src/agent/permissions.ts` |
| Harness envelopes are injection-escaped so user text cannot forge a `<tomo-event>`; model-authored inbound markers are flagged before delivery | `src/tomo-event.ts`, `src/agent/inbound-markers.ts` |
| Secrets redacted from logs; config written `0600` | `src/logger.ts`, `src/config.ts` |

Something that lets an untrusted input cross one of these lines is in scope. Examples: a message from a non-allowlisted sender that reaches the model, a group turn that reads a private record, a subagent that writes outside its profile, a crafted attachment that escapes the store directory.

## Usually not a security bug

- Prompt injection that changes what the model says or does without bypassing an allowlist, a private-memory rule, an agent profile, or a hook.
- Anything a trusted operator can do on purpose, such as configuring a shell tool or a permissive profile.
- A malicious MCP server or plugin after the user configured it.
- Multiple adversarial users sharing one Tomo install and expecting isolation from each other. Tomo has one user.
- Findings from scanners or dependency advisories with no reachable path through Tomo. Send those as normal issues or PRs.
- Exposure caused by publishing `~/.tomo/` or running the daemon under a shared account.

If you are unsure, report privately anyway.

## Supported versions

Only the latest npm release and `main` receive fixes. Run `tomo update` to stay current.
