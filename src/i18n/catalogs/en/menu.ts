/** Telegram's command menu: one description per chat command (src/channels/chat-commands.ts). */
export const menu = {
  new: "Start a new conversation",
  rewind: "Rewind context by N user messages (default 1, owner DM only)",
  model: "Switch model (Claude aliases or LiteLLM provider/model)",
  restore: "Restore config from backup and restart",
  login: "Refresh Claude login (owner DM only)",
  mcp: "Inspect or re-authenticate external MCP servers",
  status: "Show current session status",
  tasks: "List this chat's running and recent tasks (/tasks all: all of today)",
  todo: "Open todos (/todo add <text>, /todo done <id>, /todo drop <id>, /todo all)",
  cost: "Show current session costs",
  usage: "Show Claude subscription usage limits",
  pet: "Check on Tomo's pet",
  summon: "Pull your main Tomo session into this group",
  dismiss: "Hand this group back to its own Tomo session",
  pause: "Pause Tomo in this group (messages ignored until /resume)",
  resume: "Resume Tomo in this group after /pause",
} as const;
