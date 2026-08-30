import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../config.js";
import type { Agent } from "../agent.js";
import { buildCronTools } from "./cron-tools.js";
import { buildPetTools } from "./pet-tools.js";
import { buildRecallTools } from "./recall-tools.js";
import { buildPeopleTools } from "./people-tools.js";
import { isGroupSessionKey } from "../sessions/keys.js";

export const TOMO_INTERNAL_MCP_NAME = "tomo-internal";

/**
 * In-process MCP server exposing tomo-internal tools to the agent.
 *
 * Created per LiveSession, bound to that session's key so tool handlers know
 * which session is calling (the SDK itself passes no caller context). The key
 * alone is not the caller's SCOPE — a summoned group's turn runs on the
 * owner's dm: key — so anything scoped resolves it through the agent's turn
 * audience registry at call time: `agent.scopedCallerKey` for the cron tools,
 * `delegateToSession`'s own lookup for `send_message(mode: "delegate")`.
 * Delegate-to-self is intentionally not blocked (see Agent.delegateToSession
 * for rationale).
 */
export function createTomoInternalMcpServer(agent: Agent, callerSessionKey: string): McpSdkServerConfigWithInstance {
  const identityList = config.identities.map((i) => i.name);
  const identityHint = identityList.length > 0
    ? `Known identity targets: ${identityList.map((n) => `"${n}"`).join(", ")}.`
    : `No identities are configured — use a session key form instead.`;
  /**
   * Is the turn in flight this session's own? Resolved per tool call — the
   * server is built once per live session (live-session-manager.ts), but a
   * dm: session's audience changes turn to turn while a group is summoned
   * into it. False for a summoned-group turn and for a mixed batch.
   */
  const isOwnAudience = (): boolean => agent.isOwnAudienceTurn(callerSessionKey);

  return createSdkMcpServer({
    name: TOMO_INTERNAL_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "list_sessions",
        [
          "List all valid `send_message` targets — identities and active group chats — with metadata for picking the right one.",
          "",
          "Use this when you're not sure which group key to send to (group titles can be vague or renamed; participants help disambiguate).",
          "",
          "Returns: { identities: [{ name }], groups: [{ key, title?, participants? }] }. Pass the `name` (for identities) or `key` (for groups) to send_message.",
        ].join("\n"),
        {},
        async () => {
          const catalog = agent.listSessionCatalog();
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(catalog, null, 2),
            }],
          };
        },
        {
          alwaysLoad: true,
          searchHint: "list known message targets identities groups participants",
        },
      ),
      tool(
        "send_message",
        [
          "Send a chat message to another conversation (identity DM, group chat, or back to the current session).",
          "",
          "Two modes:",
          "- `delegate` (default): describe the *intent* (e.g. \"follow up with Alice about her recent trip\"). The recipient session's Claude composes the actual message in its own voice, with full local context (participant names, recent conversation, group tone). Best for social/contextual messages. Fire-and-forget — the tool returns once dispatched, the user observes the actual sent text in the recipient channel.",
          "- `direct`: send the verbatim message text. The recipient never invokes Claude — your bytes go straight to their channel. Use for factual broadcasts (\"meeting moved to 3pm\"), pasted content, or self-targeted mid-loop progress updates.",
          "",
          "When the user asks you to relay something to a group they're in, prefer `delegate` so the message fits the group's voice. Use `direct` when verbatim control matters or when the recipient session shouldn't be triggered into a Claude turn.",
          "",
          "Summoned groups: when a group has been /summon-ed into your session (its messages arrive tagged `[group \"Title\"] Sender: ...`), this tool is how you reply there — use mode `direct` with the group's session key. You compose the reply yourself; you ARE the session with the context. Do not use `delegate` for a summoned group — it would wake the group's own dormant session instead.",
          "",
          identityHint,
          "Groups are addressed by their full session key (e.g. \"telegram:-1001234567\"). Call `list_sessions` first if you don't know the right key — it returns chat titles and participants to help you pick.",
          "",
          "Self-targeting works in both modes. In `direct` mode it just posts a discrete progress bubble. In `delegate` mode it would queue an extra Claude turn on your own session — almost never what you want; use `direct` for self-progress updates.",
        ].join("\n"),
        {
          target: z.string().describe(
            "Recipient. Identity name (e.g. \"alice\") or session key (e.g. \"dm:alice\", \"telegram:-1001234567\").",
          ),
          message: z.string().min(1).max(4000).describe(
            "For `delegate`: the intent or request (the recipient's Claude composes the actual text). For `direct`: the verbatim message text.",
          ),
          mode: z.enum(["delegate", "direct"]).default("delegate").describe(
            "`delegate` (default): recipient's Claude composes the message. `direct`: send verbatim, recipient is not triggered.",
          ),
          reply_to: z.string().optional().describe(
            "Direct mode only: send as a threaded reply. Case-insensitive substring of the target message's text, matched over the chat's recent messages (newest first, seen since Tomo started). Errors without sending if nothing matches.",
          ),
          effect: z.string().optional().describe(
            "Direct mode only, iMessage only: deliver the message with an expressive-send effect. Bubble effects: impact, loud, gentle, invisibleink. Full-screen effects: confetti, lasers, fireworks, balloons, sparkles, spotlight, echo, love, celebration. Use sparingly, for moments that genuinely warrant it (a real congratulations, big news) — an effect is loud. Best-effort in every failure mode: the message always sends; the effect is dropped (with a note in the result) if the name is unknown, the channel cannot render effects, or the iMessage bridge is down.",
          ),
        },
        async ({ target, message, mode, reply_to, effect }) => {
          if (reply_to !== undefined && mode !== "direct") {
            return {
              content: [{ type: "text" as const, text: "send_message failed: reply_to requires mode \"direct\"" }],
              isError: true,
            };
          }
          if (effect !== undefined && mode !== "direct") {
            return {
              content: [{ type: "text" as const, text: "send_message failed: effect requires mode \"direct\"" }],
              isError: true,
            };
          }
          const result = mode === "direct"
            ? await agent.sendToSession(target, message, callerSessionKey, reply_to !== undefined || effect !== undefined
              ? { ...(reply_to !== undefined ? { replyTo: reply_to } : {}), ...(effect !== undefined ? { effect } : {}) }
              : undefined)
            : await agent.delegateToSession(target, message, callerSessionKey);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: result.note ? `OK (${mode}). ${result.note}` : `OK (${mode}).` }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `send_message failed: ${result.error}` }],
            isError: true,
          };
        },
        {
          alwaysLoad: true,
          searchHint: "send proactive message delegate direct identity group session",
        },
      ),
      tool(
        "rename_group_chat",
        [
          "Rename a real group chat in Telegram or iMessage.",
          "",
          "Use only when the user explicitly asks to change the group chat title. This mutates the actual chat title visible to participants.",
          "",
          "Target must be a group session key from `list_sessions` (for example `telegram:-1001234567` or `imessage:iMessage;+;chat...`). Do not pass identity names or DM sessions.",
          "",
          "Telegram requires the bot to be an admin with permission to change chat info. iMessage requires the imsg IMCore bridge to be injected (`imsg launch`).",
        ].join("\n"),
        {
          target: z.string().describe(
            "Group session key from list_sessions, e.g. `telegram:-1001234567` or `imessage:iMessage;+;chat...`.",
          ),
          title: z.string().min(1).max(128).describe(
            "New group chat title. Telegram accepts 1-128 characters; iMessage also requires a non-empty displayName.",
          ),
        },
        async ({ target, title }) => {
          const result = await agent.renameGroupChat(target, title);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: "OK. Group chat title renamed." }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `rename_group_chat failed: ${result.error}` }],
            isError: true,
          };
        },
        {
          searchHint: "rename group chat title telegram imessage imsg setChatTitle displayName",
        },
      ),
      tool(
        "react_to_message",
        [
          "React/tapback to a message in a session — the latest inbound message by default, or a specific one via `match`.",
          "",
          "Use for lightweight acknowledgements like liking, loving, laughing at, emphasizing, questioning, or removing a reaction from a message.",
          "",
          "The target is normally the current Session key from the system prompt. For another conversation, pass an identity name or session key. Without `match`, the tool reacts to the latest inbound provider message recorded for that session since Tomo started.",
          "",
          "`match` is a case-insensitive substring of the target message's text, searched over the chat's recent messages (newest first, seen since Tomo started). If nothing matches, the tool errors and nothing is sent.",
          "",
          "Reactions: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`. Telegram maps these to close emoji reactions; iMessage sends native tapbacks and requires the imsg IMCore bridge (`imsg launch`).",
        ].join("\n"),
        {
          target: z.string().describe(
            "Current session key, identity name, or session key to react in. Usually use the current Session key.",
          ),
          reaction: z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]).describe(
            "Cross-channel reaction/tapback to apply.",
          ),
          match: z.string().optional().describe(
            "Case-insensitive substring of the target message's text. Omit to react to the latest inbound message.",
          ),
          remove: z.boolean().default(false).describe(
            "Set true to remove Tomo's existing reaction/tapback of this type from the message.",
          ),
        },
        async ({ target, reaction, match, remove }) => {
          const result = await agent.reactToMessage(target, reaction, remove, match);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: remove ? "OK. Reaction removed." : "OK. Reaction sent." }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `react_to_message failed: ${result.error}` }],
            isError: true,
          };
        },
        {
          searchHint: "react reaction tapback latest message match telegram imessage imsg like love laugh",
        },
      ),
      tool(
        "edit_message",
        [
          "Edit the text of a message Tomo already sent — the most recent own message by default, or a specific one via `match`.",
          "",
          "Use when the user asks to fix or reword something Tomo just sent, or right after catching your own mistake (typo, wrong detail) in a delivered message.",
          "",
          "The target is normally the current Session key from the system prompt. `match` is a case-insensitive substring of the message's current text, searched over Tomo's own recent messages in the chat (newest first). Without `match`, the most recent message Tomo sent there is edited. Only messages sent since Tomo started are targetable. Long replies ship as multiple provider messages — each is edited separately, so use `match` to pick the right one.",
          "",
          "Platform limits: Telegram bots can edit their own messages for ~48 hours; the message shows an \"edited\" label. iMessage edits go through the imsg IMCore bridge (`imsg launch`) and are refused outright on macOS 26, where Apple removed the edit selectors OS-wide; where they do work, Apple allows edits only within 15 minutes of sending (max 5 edits, recipients can view the edit history), and pre-iOS 16 recipients see the edit as a separate \"Edited to: ...\" message. Telegram edits are capped at 4096 characters.",
        ].join("\n"),
        {
          target: z.string().describe(
            "Current session key, identity name, or session key of the conversation the message was sent in. Usually use the current Session key.",
          ),
          new_text: z.string().min(1).max(4000).describe(
            "Replacement text for the whole message (not a diff — the full new content).",
          ),
          match: z.string().optional().describe(
            "Case-insensitive substring of the message's current text, matched over Tomo's own recent messages only. Omit to edit the most recent message Tomo sent in the chat.",
          ),
        },
        async ({ target, new_text, match }) => {
          const result = await agent.editSentMessage(target, new_text, match);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: "OK. Message edited." }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `edit_message failed: ${result.error}` }],
            isError: true,
          };
        },
        {
          searchHint: "edit sent message fix typo correct reword change text telegram imessage imsg",
        },
      ),
      tool(
        "unsend_message",
        [
          "Unsend/delete a message Tomo already sent — the most recent own message by default, or a specific one via `match`.",
          "",
          "Use when the user asks to retract something Tomo sent, or right after an accidental or clearly wrong send. For fixing a typo or detail, prefer edit_message — unsending is more disruptive.",
          "",
          "Targeting works like edit_message: `match` is a case-insensitive substring searched over Tomo's own recent messages in the chat (newest first); without it, the most recent message Tomo sent there is unsent. Only messages sent since Tomo started are targetable, and long replies ship as multiple provider messages that must be unsent one by one.",
          "",
          "Platform limits: Telegram bots can delete their own messages for ~48 hours; deletion is silent (no placeholder). iMessage unsend goes through the imsg IMCore bridge (`imsg launch`), Apple allows unsend only within 2 minutes of sending, recipients see a \"message was unsent\" notice, and pre-iOS 16 recipients keep the original text.",
        ].join("\n"),
        {
          target: z.string().describe(
            "Current session key, identity name, or session key of the conversation the message was sent in. Usually use the current Session key.",
          ),
          match: z.string().optional().describe(
            "Case-insensitive substring of the message's text, matched over Tomo's own recent messages only. Omit to unsend the most recent message Tomo sent in the chat.",
          ),
        },
        async ({ target, match }) => {
          const result = await agent.unsendMessage(target, match);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: "OK. Message unsent." }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `unsend_message failed: ${result.error}` }],
            isError: true,
          };
        },
        {
          searchHint: "unsend delete retract undo sent message telegram imessage imsg",
        },
      ),
      // Scoped to the caller, like buildPeopleTools/buildRecallTools below:
      // the cron store is one flat file shared by every session, and a group
      // chat must not be able to read, remove, aim, or re-enable the owner's
      // DM jobs.
      // A getter, not the key: a summoned group's turns run on the owner's
      // dm: session, so the key alone would give the group the owner's scope.
      ...buildCronTools(undefined, () => agent.scopedCallerKey(callerSessionKey)),
      ...buildPetTools(),
      // Group sessions never see private people records through these tools —
      // same boundary as the private memory subtree they live in.
      //
      // A getter, for the same reason as the cron tools above: the session key
      // alone says "private DM" for a turn a SUMMONED GROUP is steering, since
      // that group's messages run on the owner's dm: session. `isOwnAudience`
      // resolves the turn's real audience and fails closed on a mixed batch.
      ...buildPeopleTools({
        includePrivate: () => isOwnAudience() && !isGroupSessionKey(callerSessionKey),
      }),
      // Bound to the calling session's key: recall can only read the caller's
      // own transcript, so group sessions cannot search DM history.
      //
      // Binding the key is not enough during a summon: the caller's own
      // transcript IS the owner's private DM history, and the turn asking for
      // it belongs to a group. Rather than silently searching a narrower
      // slice, recall refuses for the duration of such a turn — the owner can
      // ask again in their own DM, or dismiss the summon.
      ...buildRecallTools({
        search: (opts) => agent.searchSessionTranscript(callerSessionKey, opts),
        canSearch: isOwnAudience,
      }),
    ],
  });
}
