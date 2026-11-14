/**
 * The chat slash commands every channel recognizes, in menu order, with the
 * description Telegram shows in its command menu. The handlers live in
 * `src/agent/commands.ts`; a command added there must be added here too, or
 * no channel will route it.
 */
export const CHAT_COMMANDS: readonly { command: string; description: string }[] = [
  { command: "new", description: "Start a new conversation" },
  { command: "rewind", description: "Rewind context by N user messages (default 1, owner DM only)" },
  { command: "model", description: "Switch model (Claude aliases or LiteLLM provider/model)" },
  { command: "restore", description: "Restore config from backup and restart" },
  { command: "login", description: "Refresh Claude login (owner DM only)" },
  { command: "mcp", description: "Inspect or re-authenticate external MCP servers" },
  { command: "status", description: "Show current session status" },
  { command: "cost", description: "Show current session costs" },
  { command: "usage", description: "Show Claude subscription usage limits" },
  { command: "pet", description: "Check on Tomo's pet" },
  { command: "summon", description: "Pull your main Tomo session into this group" },
  { command: "dismiss", description: "Hand this group back to its own Tomo session" },
  { command: "pause", description: "Pause Tomo in this group (messages ignored until /resume)" },
  { command: "resume", description: "Resume Tomo in this group after /pause" },
];

export const CHAT_COMMAND_NAMES: readonly string[] = CHAT_COMMANDS.map((c) => c.command);
