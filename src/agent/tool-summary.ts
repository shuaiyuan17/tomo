/** One-line, secret-scrubbed summaries of tool calls and results for logs and the watch bus. */

import { scrubSecretValues } from "../redact.js";

/**
 * Tool summaries are the daemon's highest-volume path for other people's
 * secrets: the model reads config files, token stores and `.env`s on request,
 * and these two functions put the result into a log line AND onto the watch
 * bus. Scrubbing here rather than at each call site covers both — the watch
 * publish in `publishToolStart` never goes through pino's `logMethod` hook.
 */
export function summarizeToolResult(content: unknown): string {
  // Tool results arrive as either a string or an array of content blocks
  // ({type:"text",text:"..."} | {type:"image",...} | etc.). We flatten to a
  // short readable string for log lines — no need to be exhaustive.
  if (content == null) return "(empty)";
  if (typeof content === "string") return scrubSecretValues(content.slice(0, 500));
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        if ("text" in b && typeof (b as { text: unknown }).text === "string") {
          parts.push((b as { text: string }).text);
        } else if ("type" in b) {
          parts.push(`<${(b as { type: string }).type}>`);
        }
      }
    }
    return scrubSecretValues(parts.join(" ").slice(0, 500));
  }
  return scrubSecretValues(JSON.stringify(content).slice(0, 500));
}

/** Exported for tests. */
export function summarizeToolInput(name: string, input?: Record<string, unknown>): string {
  return scrubSecretValues(describeToolInput(name, input));
}

/**
 * A tool call's one-line title for a READER (the web UI's folded rows), where
 * `summarizeToolInput` is for logs. The model writes a short description with
 * every Bash command ("Run the test suite"); that says what the call was for
 * better than the command does, and the command is one click away in the row.
 * Everything else, and a Bash call without a description, keeps its summary.
 */
export function toolTitle(name: string, input?: Record<string, unknown>): string {
  const description = typeof input?.description === "string" ? input.description.replace(/\s+/g, " ").trim() : "";
  if (name === "Bash" && description) return scrubSecretValues(description);
  // A subagent is named by what it was sent to do; its type is in the row's input.
  if ((name === "Agent" || name === "Task") && description) return scrubSecretValues(`Subagent · ${description}`);
  const mcp = mcpTitle(name, input);
  if (mcp) return scrubSecretValues(mcp);
  return summarizeToolInput(name, input);
}

/**
 * An MCP call, `mcp__<server>__<tool>`, as `server · tool "value"`: the
 * server and the tool apart, then the input's first string value (80
 * characters), which for most tools is what the call is about (a query, a
 * title, a path). No string field, nothing after the tool's name.
 */
function mcpTitle(name: string, input?: Record<string, unknown>): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return undefined;
  const first = Object.values(input ?? {}).find((value): value is string => typeof value === "string" && value.trim() !== "");
  // Scrubbed whole before the clip: a secret cut in two would no longer match the scrubber.
  const said = first === undefined ? undefined : scrubSecretValues(first).replace(/\s+/g, " ").trim();
  return `${m[1]} · ${m[2]}${said ? ` "${said.length > 80 ? `${said.slice(0, 80)}…` : said}"` : ""}`;
}

/**
 * Whether `toolTitle` is words the model wrote (a Bash call's description, a
 * subagent's) rather than a command, path or pattern: a reader sets it in
 * the text face, not monospace.
 */
export function toolTitleIsProse(name: string, input?: Record<string, unknown>): boolean {
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  return !!description && (name === "Bash" || name === "Agent" || name === "Task");
}

function describeToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Read": return `Read ${input.file_path}`;
    case "Write": return `Write ${input.file_path}`;
    case "Edit": return `Edit ${input.file_path}`;
    case "Bash": return `Bash: ${String(input.command).slice(0, 500)}`;
    case "Glob": return `Glob ${input.pattern}`;
    case "Grep": return `Grep "${input.pattern}"`;
    case "WebSearch": return `WebSearch: ${input.query}`;
    case "WebFetch": return `WebFetch: ${input.url}`;
    case "Agent": case "Task": return `Agent → ${input.subagent_type ?? "?"}: ${String(input.description ?? "").slice(0, 80)}`;
    default: return `${name}: ${JSON.stringify(input).slice(0, 500)}`;
  }
}
