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
  { command: "tasks", description: "List this chat's running and recent tasks (/tasks all: all of today)" },
  { command: "todo", description: "Open todos (/todo add <text>, /todo done <id>, /todo drop <id>, /todo all)" },
  { command: "cost", description: "Show current session costs" },
  { command: "usage", description: "Show Claude subscription usage limits" },
  { command: "pet", description: "Check on Tomo's pet" },
  { command: "summon", description: "Pull your main Tomo session into this group" },
  { command: "dismiss", description: "Hand this group back to its own Tomo session" },
  { command: "pause", description: "Pause Tomo in this group (messages ignored until /resume)" },
  { command: "resume", description: "Resume Tomo in this group after /pause" },
];

export const CHAT_COMMAND_NAMES: readonly string[] = CHAT_COMMANDS.map((c) => c.command);

/** `/task` is an alias of `/tasks`; both reach the handler as "tasks". */
export const TASKS_COMMAND = "tasks";
const TASKS_NAMES = new Set(["task", "tasks"]);

/**
 * Recognize `/task` or `/tasks` (any case, surrounding whitespace allowed),
 * optionally addressed `/tasks@botname` — accepted only when `botUsername`
 * is given and matches (case-insensitively), as Telegram does for every
 * command. Returns the trimmed arguments, or undefined when it is not one.
 */
export function parseTasksCommand(text: string, botUsername?: string): { args: string } | undefined {
  const match = /^\/([A-Za-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !TASKS_NAMES.has(match[1].toLowerCase())) return undefined;
  if (match[2] !== undefined && (!botUsername || match[2].toLowerCase() !== botUsername.toLowerCase())) return undefined;
  return { args: (match[3] ?? "").trim() };
}
