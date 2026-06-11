# Summon — pull the main DM session into a group

Status: **prototype, second iteration** — tool-based replies, persistent state, inactivity expiry.

## What it is

Normally a group chat has its own isolated Tomo session (`telegram:-987`), with no access to
the owner's personal context. **Summon** lets the owner temporarily route a group's messages
to their main `dm:<identity>` session instead — full personal memory and conversation context.
When done, the group is handed back to its own session.

- `/summon` (in a group) — the sender's main session takes over the group.
- `/dismiss` (in a group) — hand back to the group's own session.
- Auto-handback after `summonExpiryMinutes` (default 60) of group inactivity; `0` disables.
- `/status` (in a group) — shows `Summoned: messages route to dm:<identity>` when active.

## Reply model: nothing auto-posts to the group

The first iteration had the harness deliver the dm session's turn output to the group
(`replyTarget` = group). That created a family of wrong-audience hazards: coalesced batches
mixing DM and group messages reply to one target, steered messages merge into an in-flight
turn owned by a different audience, etc.

The current model inverts it:

- **Inbound**: summoned group messages arrive in the dm session tagged
  `[group "Title"] Sender: ...`, with a short per-turn system reminder appended to the prompt
  (not the transcript) explaining the routing.
- **Group-facing replies** happen only via an explicit `send_message` tool call with mode
  `direct` and the group's session key. The model composes the reply itself — it *is* the
  session with the context. (`delegate` mode would wake the group's own dormant session,
  which is exactly what summoning bypasses — the tool description and AGENT.md call this out.)
- **Direct turn output** goes to the owner's **private DM** (`replyTarget` = the dm session's
  persisted/derived private target). That's a useful side-channel ("FYI I told the group X");
  the model replies `NO_REPLY` when there's nothing to say privately.

This makes batching and steering audience-safe by construction: a merged or mixed turn can't
deliver to the wrong place because the only path into the group is an explicit, per-message
tool call. The trade-offs: no streaming or typing indicator in the group, no reply-threading,
and group replies depend on the model following the reminder — mitigated by the per-turn
reminder, the summon-time pending note, the `send_message` tool description, and AGENT.md.

## How it works

1. **Routing override** (`src/router.ts`): `IdentityRouter.resolve()` is the single choke point
   every ingress path goes through. For a summoned group it returns
   `sessionKey: dm:<identity>` + the dm session's private reply target. Group traffic touches
   the summon's activity clock; expiry is detected lazily on the next lookup (no timer) and
   fires `onSummonExpired`, which posts a handback notice to the group and queues a pending
   note for the dm session.
2. **Persistence** (`src/sessions/summon-store.ts`): summon state lives in
   `~/.tomo/data/summons.json` (atomic writes, corrupt-file tolerant) and survives daemon
   restarts. Activity touches are persisted at most once per minute per key.
3. **Owner gating** (`src/agent.ts` → `handleSummonCommand`): `CommandHandler` carries a
   provider-verified `senderId` (Telegram `from.id`, iMessage handle address). `/summon` only
   succeeds if that id is bound to a configured identity — and that identity's session is the
   one summoned. Display names are never trusted.
4. **Context briefing**: the dm session's system prompt has no group context, so four layers
   compensate: a pending note on summon/dismiss/expiry (existing `pendingNotes` mechanism), the
   per-message `[group "Title"] Sender:` tag, the per-turn reply-routing reminder, and an
   **audience-switch note** (`src/agent/audience.ts`) injected whenever consecutive inbound
   messages on the dm session hop between the private DM and a group (or between two summoned
   groups, or mix audiences inside one coalesced batch) — the switch moment is where tone or
   private context is most likely to be carried across by mistake.
5. **Group bookkeeping stays put**: participants/title tracking is keyed by the raw group key
   even while summoned, so the group's own session entry stays fresh for handback.

Passive-listen vs mention-required semantics are unchanged — they key off (channel, chatId),
not the session key.

## Config

```jsonc
// ~/.tomo/config.json
{
  "summonExpiryMinutes": 60   // default 60; 0 = summons never expire
}
```

Env override: `TOMO_SUMMON_EXPIRY_MINUTES`.

## Privacy model

Summoning is *deliberately* a privacy trade: the group gets answers informed by the owner's
personal context. Guardrails:

- Only the owner (provider-verified id) can summon, and only their own session.
- Nothing auto-posts to the group — every group-facing message is an explicit tool call.
- Cron/continuity/direct replies all go to the private DM (group reply target never persisted).
- Summons lapse after inactivity by default, so a forgotten summon isn't a standing hole.
- The model is briefed at summon time and reminded per turn that group output is public.

Known gaps:

- **Private-memory tool guard is not active.** Group sessions run with a `privateMemoryGuardHooks`
  PreToolUse guard; the dm `LiveSession` doesn't have it. The model is *asked* not to leak
  (and group output now requires a deliberate tool call, which helps), but not *prevented*.
- **Group conversation lands in the DM transcript/context permanently.** Arguably the feature,
  but LCM rollups may mix group threads into personal memory.

## Open questions

1. **Multi-identity groups.** Two owners in one group: a second `/summon` is refused until
   `/dismiss`. The refusal reveals whose session is active — acceptable?
2. **Reminder fatigue.** The per-turn reminder costs ~60 tokens per summoned message. Could be
   dropped to every-Nth-turn once confidence in the AGENT.md instructions is established.
3. **`/new` and `/model` in a summoned group** still operate on the raw group key (pre-existing
   `resolve(..., isGroup: false)` quirk in `handleCommand`), not the summoned dm session.
   Probably correct, but worth deciding deliberately.
4. **Expiry notice timing.** Expiry is lazy, so the "summon expired" group notice posts when the
   next group message arrives (just before the group session's reply) — slightly after the fact.
   A timer could make it prompt, at the cost of timer bookkeeping.
