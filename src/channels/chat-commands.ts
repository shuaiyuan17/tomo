import { ownerT, type Locale } from "../i18n/index.js";

/**
 * The chat slash commands every channel recognizes, in menu order, with the
 * description Telegram shows in its command menu (in `locale`). The handlers
 * live in `src/agent/commands.ts`; a command added there must be added here
 * too, or no channel will route it.
 */
export function chatCommandMenu(locale: Locale = "en"): { command: string; description: string }[] {
  const t = ownerT("menu", locale);
  return [
    { command: "new", description: t("new") },
    { command: "rewind", description: t("rewind") },
    { command: "model", description: t("model") },
    { command: "restore", description: t("restore") },
    { command: "login", description: t("login") },
    { command: "mcp", description: t("mcp") },
    { command: "status", description: t("status") },
    { command: "tasks", description: t("tasks") },
    { command: "todo", description: t("todo") },
    { command: "cost", description: t("cost") },
    { command: "usage", description: t("usage") },
    { command: "pet", description: t("pet") },
    { command: "summon", description: t("summon") },
    { command: "dismiss", description: t("dismiss") },
    { command: "pause", description: t("pause") },
    { command: "resume", description: t("resume") },
  ];
}

/** The English menu (Telegram's default, for clients in any other language). */
export const CHAT_COMMANDS: readonly { command: string; description: string }[] = chatCommandMenu("en");

/**
 * The menu per Telegram `language_code` (an IETF tag, language only) beyond
 * the default: a client whose language is Chinese sees the zh-Hans one.
 */
export const LOCALIZED_CHAT_COMMAND_MENUS: readonly { languageCode: string; commands: { command: string; description: string }[] }[] = [
  { languageCode: "zh", commands: chatCommandMenu("zh-Hans") },
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
