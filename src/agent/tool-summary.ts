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
