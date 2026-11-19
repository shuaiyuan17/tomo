/**
 * Split of the session system prompt into a cross-session-cacheable prefix and
 * a per-session suffix, separated by the SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
 *
 * Blocks before the marker are eligible for prompt caching ACROSS sessions:
 * two sessions whose static prefix is byte-identical can share one cache entry,
 * so a fresh session (new group, a session rebuilt after a restart or a prompt
 * change) reads the workspace prompt from cache instead of re-writing it.
 * Blocks after the marker are cached per session only.
 *
 * Static here means "identical for every session of the same audience":
 * `buildSystemPrompt({ isGroup })` has two variants (DM / group) because group
 * sessions see MEMORY and PEOPLE with private entries stripped and no home
 * note. Each variant is its own shared prefix. Nothing that names one session
 * (session key, SDK session id, group title, participants, listen mode) or
 * that can change per session (the model) may go before the marker — one such
 * byte and every session gets a private copy of the whole prefix again.
 *
 * The CLI flattens the array back to a single string, joining elements with a
 * blank line, whenever it does not use the scoped cache (e.g. behind a gateway
 * base URL). The dynamic sections are therefore rendered WITHOUT a leading
 * blank line, so the flattened text is byte-identical to the old
 * `static + "\n\n# SESSION…" + "\n\n# RUNTIME…"` string.
 */

/**
 * The SDK's marker, restated locally rather than imported as a value: most
 * test files replace the SDK module with a mock that has no such export, and
 * a missing named export from a vi.mock factory throws. The declared type is
 * the SDK's own literal type, so `tsc` fails if the SDK ever changes the
 * string (and tests/system-prompt-cache-boundary.test.ts compares it to the
 * real export at runtime).
 */
type SdkBoundary = typeof import("@anthropic-ai/claude-agent-sdk")["SYSTEM_PROMPT_DYNAMIC_BOUNDARY"];
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY: SdkBoundary = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export interface SessionPromptContext {
  sessionKey: string;
  sdkSessionId?: string;
  group?: {
    chatTitle?: string;
    participants?: string[];
    isPassive: boolean;
  };
}

/** The `# SESSION` block: everything that identifies this one session. */
export function renderSessionSection(ctx: SessionPromptContext): string {
  const lines = [
    "# SESSION",
    `- Session key: ${ctx.sessionKey}`,
  ];
  if (ctx.sdkSessionId) {
    lines.push(`- SDK session ID: ${ctx.sdkSessionId}`);
  }
  if (ctx.group) {
    const g = ctx.group;
    lines.push("");
    lines.push("## Group Chat Context");
    if (g.chatTitle) lines.push(`- Group title: "${g.chatTitle}"`);
    if (g.participants && g.participants.length > 0) {
      lines.push(`- Known participants: ${g.participants.join(", ")}`);
    }
    lines.push("- Incoming messages identify the sender. A canonical PEOPLE name in parentheses refers to the same person.");
    if (g.isPassive) {
      lines.push("- **Listen mode: passive.** You see every message. Reply only when directly addressed or genuinely useful; otherwise reply `NO_REPLY`.");
    } else {
      lines.push("- **Listen mode: mention-required.** Every message you receive explicitly tagged you; respond as in a DM.");
    }
  }
  return lines.join("\n");
}

/** The `# RUNTIME` block: the model serving this session. */
export function renderRuntimeSection(modelDisplay: string): string {
  return `# RUNTIME\n- Current model: ${modelDisplay}\n- Treat this model value as authoritative.`;
}

/**
 * `[static, BOUNDARY, ...dynamic]`. Empty blocks are dropped; the marker is
 * always present so the static part is always the cacheable prefix.
 */
export function assembleSystemPrompt(staticPrompt: string, dynamicSections: string[]): string[] {
  return [
    ...(staticPrompt ? [staticPrompt] : []),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ...dynamicSections.filter(Boolean),
  ];
}

/** The blocks before the marker — the part shared across sessions. */
export function staticPromptBlocks(blocks: readonly string[]): string[] {
  const i = blocks.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  return i === -1 ? [...blocks] : blocks.slice(0, i);
}

/**
 * The prompt text the model reads, as the CLI flattens it when it does not
 * split into cache scopes: non-empty, non-marker blocks joined by a blank line.
 * Use this anywhere a single string is needed (hashing, logging, tests) so the
 * marker itself never counts as content.
 */
export function flattenSystemPrompt(blocks: string | readonly string[]): string {
  if (typeof blocks === "string") return blocks;
  return blocks.filter((b) => b !== "" && b !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join("\n\n");
}
