# Spike: Summon — pull the main DM session into a group

Status: **spike / prototype** — working end-to-end, but with deliberate shortcuts (see Open Questions).

## What it is

Normally a group chat has its own isolated Tomo session (`telegram:-987`), with no access to
the owner's personal context. **Summon** lets the owner temporarily route a group's messages
to their main `dm:<identity>` session instead — full personal memory and conversation context —
while replies still post to the group. When done, the group is handed back to its own session.

- `/summon` (in a group) — the sender's main session takes over the group.
- `/dismiss` (in a group) — hand back to the group's own session.
- `/status` (in a group) — shows `Summoned: messages route to dm:<identity>` when active.

Naming alternatives considered: "travel", "takeover", "visit". "Summon" reads naturally as a
pair of commands (`/summon` / `/dismiss`) and describes the direction (you pull your Tomo *in*).

## How it works

The whole feature hinges on one fact: `IdentityRouter.resolve(channel, chatId, isGroup)` is the
single choke point that every ingress path (messages, batching, queueing) goes through to get a
`sessionKey` + `replyTarget`.

1. **Routing override** (`src/router.ts`): the router keeps an in-memory map
   `summonedGroups: rawGroupKey → identityName`. For a summoned group, `resolve()` returns
   `sessionKey: dm:<identity>` with `replyTarget` still pointing at the group. Crucially it does
   **not** persist that replyTarget on the dm session — cron jobs and continuity heartbeats keep
   delivering to the private DM, never the group.

2. **Serialization for free**: the per-session message queue and coalescing in `Agent` are keyed
   by resolved sessionKey, so summoned group traffic and DM traffic automatically serialize onto
   the same `LiveSession` — no concurrent `send()` on one SDK session.

3. **Owner gating** (`src/agent.ts` → `handleSummonCommand`): `CommandHandler` now carries a
   provider-verified `senderId` (Telegram `from.id`, iMessage handle address). `/summon` only
   succeeds if that id is bound to a configured identity — and that identity's session is the one
   summoned. Display names are never trusted.

4. **Context briefing**: the dm session's system prompt has no group context (it was built as a
   DM session). Two mechanisms compensate:
   - On summon/dismiss, a *pending note* (existing `pendingNotes` mechanism) is queued on the dm
     key, so the model's next turn opens with "you've been summoned into group X; everyone can
     read your replies; keep private memory out of them".
   - Every summoned group message is prefixed `[group "Title"] Sender: ...` (see
     `Agent.formatGroupText`), so the model knows per-message which audience it's writing for.

5. **Group bookkeeping stays put**: participants/title tracking is keyed by the raw group key even
   while summoned, so the group's own session entry stays fresh for when it takes back over.

Passive-listen vs mention-required semantics are unchanged — they key off (channel, chatId), not
the session key, so a passive iMessage group stays passive while summoned.

## What was touched

| File | Change |
|---|---|
| `src/router.ts` | `summonGroup` / `dismissGroup` / `getSummonedIdentity` / `identityForSender`; summon override in `resolve()` |
| `src/agent.ts` | `/summon` & `/dismiss` handling, pending-note briefings, `[group ...]` message tagging, status line |
| `src/channels/types.ts` | `CommandHandler` gains optional provider-verified `senderId` |
| `src/channels/telegram.ts` | register commands, pass `ctx.from.id` |
| `src/channels/imessage.ts` | whitelist commands, pass handle address |
| `tests/router.test.ts` | summon routing tests |

## Privacy model (read this before productionizing)

Summoning is *deliberately* a privacy trade: the whole point is that the group gets answers
informed by the owner's personal context. Current guardrails:

- Only the owner (provider-verified id) can summon, and only their own session.
- Cron/continuity replies never leak to the group (replyTarget not persisted).
- The model is explicitly told the audience changed (pending note + per-message tag).

Known gaps:

- **Private-memory tool guard is not active.** Group sessions run with a `privateMemoryGuardHooks`
  PreToolUse guard; the dm `LiveSession` was created without it and hooks can't be added to a
  live SDK session. The model is *asked* not to leak, not *prevented*. A real version could close
  the dm LiveSession on summon and recreate it with the guard (cost: loses warm in-flight state).
- **Group conversation lands in the DM transcript/context permanently.** That's arguably the
  feature (the owner wants continuity), but it pollutes DM rollups; LCM summaries may mix group
  threads into personal memory.

## Open questions for productionizing

1. **Persistence across restarts.** Summon state is in-memory only — a daemon restart silently
   dismisses. Safe default for a spike (a summon can't outlive the daemon that granted it), but
   surprising. Option: persist on the group's `SessionEntry` with a TTL.
2. **Auto-expiry.** Should a summon expire after N hours of group inactivity? Probably yes —
   a forgotten summon is a standing privacy hole.
3. **Steering edge.** With `config.steering` on, a summoned group message could steer into an
   in-flight DM turn (and vice versa), and the merged reply is delivered to the *owning* turn's
   target. Mixed-audience merge is the one real correctness wart. Cheapest fix: never steer
   group-originated messages (force the queue path when `message.isGroup`).
4. **Mixed batches.** A summoned passive group's messages can coalesce into one batch with DM
   messages (same session key). Per-item `[group ...]` tagging keeps the model oriented, but the
   batch's reply target is the *last* message's — a reply meant partly for the DM could post to
   the group. Could split batches by reply target before draining.
5. **`/new` and `/model` in a summoned group** still operate on the raw group key (pre-existing
   `resolve(..., isGroup: false)` quirk in `handleCommand`), not the summoned dm session. Probably
   correct, but worth deciding deliberately.
6. **Multi-identity groups.** Two owners in one group: last `/summon` wins? Currently a second
   summon is refused until `/dismiss`. Fine, but the refusal message reveals whose session is
   active — acceptable?
