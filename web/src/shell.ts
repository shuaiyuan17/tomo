/**
 * Short names for shell tasks, whose description is the whole command line
 * (`cd /long/path && git switch -q … && python3 - <<'EOF' …`). Pure, so the
 * card and the task view agree and it is testable.
 */

/** Home directories become ~ ; deep paths keep only their last part. */
export function shortenPaths(text: string): string {
  return text
    .replace(/(^|[\s'"=(])\/(?:Users|home)\/[^/\s'"]+(?=\/|\s|$|['")])/g, "$1~")
    .replace(/(^|[\s'"=(])((?:~|\/)[^\s'"]*\/)([^/\s'"]+)(?=$|[\s'")])/g, (match, lead: string, dir: string, last: string) =>
      dir.split("/").filter(Boolean).length >= 2 ? `${lead}…/${last}` : match);
}

/**
 * Split on && || ; | at the top level: not inside quotes, not escaped with a
 * backslash, not inside ( … ) or $( … ) (tracked by depth).
 */
function segments(line: string): Array<{ text: string; joiner: string }> {
  const out: Array<{ text: string; joiner: string }> = [];
  let current = "", quote = "", joiner = "", depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && quote !== "'") { current += c + (line[i + 1] ?? ""); i++; continue; }
    if (quote) { current += c; if (c === quote) quote = ""; continue; }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    if (c === "(") { depth++; current += c; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); current += c; continue; }
    if (depth > 0) { current += c; continue; }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push({ text: current.trim(), joiner }); joiner = two; current = ""; i++; continue; }
    if (c === ";" || c === "|") { out.push({ text: current.trim(), joiner }); joiner = c; current = ""; continue; }
    current += c;
  }
  out.push({ text: current.trim(), joiner });
  return out.filter((s) => s.text);
}

const SUBCOMMAND_TOOLS = new Set(["git", "npm", "npx", "pnpm", "yarn", "gh", "docker", "cargo", "go", "brew", "kubectl", "bun", "uv", "pip", "pip3", "make"]);
const tokens = (text: string) => text.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
const base = (word: string) => word.replace(/^.*\//, "");

/** One segment as "cmd sub" / "script.sh arg" / "python3 (heredoc)". */
function describe(segment: string): string | undefined {
  const words = tokens(segment);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift(); // FOO=1 cmd
  const first = words[0];
  if (first === undefined) return undefined;
  const cmd = base(first);
  if (cmd === "cd") return undefined;
  if (/<<-?\s*['"]?\w+/.test(segment)) return `${cmd} (heredoc)`;
  const args = words.slice(1).filter((w) => !w.startsWith("-") && !w.includes("/") && !w.startsWith("~") && !w.startsWith("<") && !w.startsWith(">"));
  if (SUBCOMMAND_TOOLS.has(cmd) && args[0]) return `${cmd} ${args[0]}`;
  if (cmd === "sleep" && args[0]) return `sleep ${args[0]}`;
  const arg = args.find((w) => /^[\w.:@#-]{1,20}$/.test(w));
  return arg && !SUBCOMMAND_TOOLS.has(cmd) && /\.(sh|py|js|ts|mjs)$/.test(cmd) ? `${cmd} ${arg}` : cmd;
}

export const SHORT_NAME_MAX = 40;

/** A short, single-line name for a command line; at most SHORT_NAME_MAX characters. */
export function shellShortName(command: string): string {
  const firstLine = command.split("\n")[0];
  let list = segments(firstLine);
  // A leading subshell `( … )` is described by what runs inside it.
  const sub = /^\(([\s\S]*)\)$/.exec(list[0]?.text ?? "");
  if (sub && list.length === 1) list = segments(sub[1]);
  else if (sub) list = [...segments(sub[1]), ...list.slice(1)];
  const parts = list.map((s) => ({ ...s, name: describe(s.text) })).filter((s) => s.name);
  if (!parts.length) return shortenPaths(firstLine).slice(0, SHORT_NAME_MAX) || "shell";
  let name = parts[0].name!;
  const next = parts[1];
  if (next && parts[0].name!.startsWith("sleep") && next.joiner !== "|") name += `; ${next.name}`;
  else if (next && next.joiner === "|") name += ` | ${next.name}`;
  return name.length > SHORT_NAME_MAX ? `${name.slice(0, SHORT_NAME_MAX - 1)}…` : name;
}

/** Shell-type tasks (their description is a command line). */
export function isShellTask(taskType: string): boolean {
  return taskType === "local_bash";
}
