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
| With `credentialBroker.enabled`: an owner's reply to a credential request (iMessage or Telegram: their next message in that private chat) reaches no transcript, log or model turn; `request_credential` refuses anything but the owner's own private turn, and any turn the owner is not typing in (cron, heartbeat). Limits below. | `src/credentials/`, `src/agent.ts` |
| Telegram credential capture: the captured message is deleted from the private chat (Bot API `deleteMessage`); a refusal is reported to the owner, who must delete it | `src/credentials/broker.ts`, `src/channels/telegram.ts` |
| Web UI credential card: the value is posted to `POST /api/v1/credentials/<id>` (exact Origin, cookie, CSRF, daemon epoch, owner), never `/messages`, so it is not journaled, drawn as a bubble or recorded; the `credential-request` event and the bootstrap carry name and purpose only; error responses are fixed codes that never echo the body | `src/web/http.ts`, `src/channels/web.ts`, `web/src/credential-card.tsx` |
| Known credential values are masked in every tool's successful output (one global `PostToolUse` hook, Bash included) and in logs | `src/agent/sdk-options.ts`, `src/credentials/redactor.ts`, `src/redact.ts` |

Something that lets an untrusted input cross one of these lines is in scope. Examples: a message from a non-allowlisted sender that reaches the model, a group turn that reads a private record, a subagent that writes outside its profile, a crafted attachment that escapes the store directory.

## Credential broker: what it does not stop

The broker (off by default) has one job: when the owner is clearly sending a password, it does not go straight through the model. **It does not defend against a malicious or compromised model.** That model has a shell as the same user. Reports of the following are known and not vulnerabilities.

- **The model can read the keychain itself, by design.** Values are stored in the login keychain by `/usr/bin/security`, which is on the item's default access list, and the agent is TOLD to read them with `$(security find-generic-password -s tomo-credential-broker -a <name> -w)` inside a command. Nothing stops it printing the value instead; only the literal mask below catches that.
- **Messages keep the plaintext.** On iMessage, a value stays in the Messages database until the owner deletes the message (and in iCloud Messages, if enabled), and the agent can read that database. On Telegram the bot deletes the message, but it can refuse (the owner is told), and the owner's other devices may have shown it already.
- **A command given a value can do anything with it.** The mask is literal. Any encoding or transformation, or a `curl` to another host, gets past it.
- **Masking is partial.** It covers the literal value in tool results that succeed. The CLI cannot rewrite a failed tool's output, so a Bash command that prints a value and exits non-zero is not masked. Images are not masked. A value is only known once stored or loaded in this process, so a replaced value stops being masked after a restart. Output merged by the command itself (`2>&1`) can split a value. Printing a candidate shows whether it was masked, which confirms a guess.
- **Replies around the window can reach the model.** A message sent well after the five-minute timeout, or a second bubble after the captured one, is an ordinary message. A message's send time is judged with two minutes of slack, so clock skew beyond that can pass a late reply. A reply beginning with one of Tomo's slash commands runs as that command.
- **Off-channel messages are dropped, not forwarded.** While a request is open, the owner's messages on the other chat channel (iMessage or Telegram) are dropped, since one may be the value, and the owner is told. The web chat is not affected: a value never arrives through it.
- **An unreadable state file holds back a channel.** If `~/.tomo/data/credentials/state.json` cannot be read, owner messages on the chat channel it still names a request for are held back (all chat channels, if nothing in it can be read) until it is repaired. Never the web chat.
- **`purpose` is written by the agent.** The prompt and the card label it unverified, but it can mislead the owner.
- **The web card is only as safe as the web UI.** Anyone holding the web access link and a session cookie can answer it; the same is true of everything else the web UI can do.

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
