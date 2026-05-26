import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../config.js";
import type { Agent } from "../agent.js";
import { buildCronTools } from "./cron-tools.js";
import { buildPetTools } from "./pet-tools.js";

export const TOMO_INTERNAL_MCP_NAME = "tomo-internal";

/**
 * In-process MCP server exposing tomo-internal tools to the agent.
 *
 * Created once at Agent construction and shared across all LiveSessions.
 * Tool handlers do not receive caller session context; delegate-to-self is
 * intentionally not blocked (see Agent.delegateToSession for rationale).
 */
export function createTomoInternalMcpServer(agent: Agent): McpSdkServerConfigWithInstance {
  const identityList = config.identities.map((i) => i.name);
  const identityHint = identityList.length > 0
    ? `Known identity targets: ${identityList.map((n) => `"${n}"`).join(", ")}.`
    : `No identities are configured — use a session key form instead.`;

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
        },
        async ({ target, message, mode }) => {
          const result = mode === "direct"
            ? await agent.sendToSession(target, message)
            : await agent.delegateToSession(target, message);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: `OK (${mode}).` }],
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
          "Rename a real group chat in Telegram or iMessage/BlueBubbles.",
          "",
          "Use only when the user explicitly asks to change the group chat title. This mutates the actual chat title visible to participants.",
          "",
          "Target must be a group session key from `list_sessions` (for example `telegram:-1001234567` or `imessage:iMessage;+;chat...`). Do not pass identity names or DM sessions.",
          "",
          "Telegram requires the bot to be an admin with permission to change chat info. BlueBubbles requires the Private API/helper to be enabled.",
        ].join("\n"),
        {
          target: z.string().describe(
            "Group session key from list_sessions, e.g. `telegram:-1001234567` or `imessage:iMessage;+;chat...`.",
          ),
          title: z.string().min(1).max(128).describe(
            "New group chat title. Telegram accepts 1-128 characters; iMessage/BlueBubbles also requires a non-empty displayName.",
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
          searchHint: "rename group chat title telegram imessage bluebubbles setChatTitle displayName",
        },
      ),
      tool(
        "react_to_latest_message",
        [
          "React/tapback to the latest inbound message Tomo has seen in a session.",
          "",
          "Use for lightweight acknowledgements like liking, loving, laughing at, emphasizing, questioning, or removing a reaction from the latest message.",
          "",
          "The target is normally the current Session key from the system prompt. For another conversation, pass an identity name or session key. The tool reacts to the latest inbound provider message recorded for that session since Tomo started.",
          "",
          "Reactions: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`. Telegram maps these to close emoji reactions; iMessage/BlueBubbles sends native tapbacks and requires the Private API/helper.",
        ].join("\n"),
        {
          target: z.string().describe(
            "Current session key, identity name, or session key to react in. Usually use the current Session key.",
          ),
          reaction: z.enum(["love", "like", "dislike", "laugh", "emphasize", "question"]).describe(
            "Cross-channel reaction/tapback to apply to the latest inbound message.",
          ),
          remove: z.boolean().default(false).describe(
            "Set true to remove Tomo's existing reaction/tapback of this type from the latest message.",
          ),
        },
        async ({ target, reaction, remove }) => {
          const result = await agent.reactToLatestMessage(target, reaction, remove);

          if (result.ok) {
            return {
              content: [{ type: "text" as const, text: remove ? "OK. Reaction removed." : "OK. Reaction sent." }],
            };
          }
          return {
            content: [{ type: "text" as const, text: `react_to_latest_message failed: ${result.error}` }],
            isError: true,
          };
        },
        {
          searchHint: "react reaction tapback latest message telegram imessage bluebubbles like love laugh",
        },
      ),
      ...buildCronTools(),
      ...buildPetTools(),
    ],
  });
}
