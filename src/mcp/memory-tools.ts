import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { LIST_MAX_ENTRIES, MemoryStore, MemoryToolError, type MemoryAccess } from "../memory/store.js";

export const MEMORY_READ_TOOL_NAMES = ["memory_list", "memory_read", "memory_search"] as const;
export const MEMORY_WRITE_TOOL_NAMES = ["memory_write", "memory_str_replace", "memory_append", "memory_move", "memory_delete"] as const;
export const MEMORY_TOOL_NAMES = [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES] as const;

/**
 * The memory tools, on the `tomo-internal` server: the one way the agent
 * writes `memory/**\/*.md` (the store guard refuses the file tools there).
 *
 * `access` is resolved per call, like the people and todo tools' scope: a
 * summoned group's turn runs on the owner's dm: session, so the session key
 * alone would hand the group the owner's reach. The rules themselves live in
 * `MemoryStore`; these handlers only translate.
 *
 * `readOnly`: only the three reading tools (a sub-session).
 */
export function buildMemoryTools(deps: { store: () => MemoryStore; access: () => MemoryAccess; readOnly?: boolean }) {
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const run = (name: string, fn: () => string) => {
    try {
      return ok(fn());
    } catch (err) {
      if (err instanceof MemoryToolError) return { content: [{ type: "text" as const, text: `${name} failed: ${err.message}` }], isError: true };
      throw err;
    }
  };

  const reads = [
    tool(
      "memory_list",
      'List memory files with their description and version. `prefix` narrows to a folder, e.g. "private/work/". It also shows what the Memory files list folds, and journal/ and archive/ folders.',
      {
        prefix: z.string().optional().describe('A folder relative to memory/, e.g. "work/" or "private/journal/". Omit for every listed file.'),
      },
      async ({ prefix }) => run("memory_list", () => {
        const { entries, truncated, unlisted } = deps.store().list(deps.access(), prefix);
        const shown = entries.slice(0, LIST_MAX_ENTRIES);
        const lines = shown.map((e) => `- ${e.path} — ${e.description ?? "⚠ no description yet: add one next time you touch this file"} (version ${e.version})`);
        if (!lines.length) lines.push(prefix ? `(no memory files under ${prefix})` : "(no topic files yet)");
        if (entries.length > shown.length) lines.push(`(${entries.length - shown.length} more not shown: pass a narrower prefix)`);
        if (unlisted) lines.push(`(${unlisted} more under journal/ and archive/ folders: pass their folder as prefix)`);
        if (truncated) lines.push("(the scan stopped early: pass a prefix to see the rest)");
        return lines.join("\n");
      }),
      { searchHint: "memory list files folders descriptions versions" },
    ),
    tool(
      "memory_read",
      'Read one memory file. Returns its content and version. `path` is relative to memory/, e.g. "private/travel.md". For a long file, `offset` and `limit` read a range of lines.',
      {
        path: z.string().describe('Relative to memory/, e.g. "travel.md".'),
        offset: z.number().int().min(1).optional().describe("First line to read (1-based)."),
        limit: z.number().int().min(1).optional().describe("How many lines to read (default 2000)."),
      },
      async ({ path, offset, limit }) => run("memory_read", () => deps.store().read(deps.access(), path, offset, limit)),
      { searchHint: "memory read file content version" },
    ),
    tool(
      "memory_search",
      "Find lines in memory files that match `query`, scored like recall_conversation: whole words in any order (case-insensitive), rarer words count more, Chinese and Japanese by two-character pieces; a line needs most of the query, and one with the exact phrase ranks highest. Returns the best matches as path, line number and the line, in file order. Files under journal/ are left out unless `include_journal` is true. Use it before you add a fact, and to find every copy of a value you are correcting.",
      {
        query: z.string().min(1).max(200).describe("A few distinctive words, or the exact value to find."),
        include_journal: z.boolean().optional().describe("Also search journal/ folders (default false)."),
      },
      async ({ query, include_journal }) => run("memory_search", () => {
        const { hits, truncated } = deps.store().search(deps.access(), query, { journal: include_journal === true });
        if (!hits.length) return truncated ? `No match for "${query}" in the part searched (the search stopped early).` : `No match for "${query}".`;
        const lines = hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
        if (truncated) lines.push(`(showing the best ${hits.length}; more lines matched or the time limit was hit: search for something more specific)`);
        return lines.join("\n");
      }),
      { searchHint: "memory search find text copies grep facts" },
    ),
  ];
  if (deps.readOnly) return reads;

  return [
    ...reads,
    tool(
      "memory_write",
      'Create a memory file or replace it whole. `if_version`: "new" to create, else the version from your last read; if the file changed since, you get its new version: read it again and retry. The replaced content is kept for 30 days. Files need frontmatter with a `description:` (one line, at most 200 characters) that says when to read them. People records go through upsert_person.',
      {
        path: z.string().describe('Relative to memory/, e.g. "travel.md".'),
        content: z.string().describe("The whole new content of the file."),
        if_version: z.string().min(1).describe('"new" to create the file; otherwise the version memory_read or memory_list gave you.'),
      },
      async ({ path, content, if_version }) => run("memory_write", () => deps.store().writeFile(deps.access(), path, content, if_version)),
      { searchHint: "memory write create replace save file remember" },
    ),
    tool(
      "memory_str_replace",
      "Change one part of a memory file. `old` must appear exactly once; widen it with nearby text until it does. An empty `new` deletes it. Use this for a correction, so the old line is replaced rather than kept beside the new one.",
      {
        path: z.string().describe('Relative to memory/, e.g. "MEMORY.md".'),
        old: z.string().min(1).describe("The exact text to replace; must appear exactly once."),
        new: z.string().describe("What replaces it. Empty deletes it."),
      },
      async (args) => run("memory_str_replace", () => deps.store().strReplace(deps.access(), args.path, args.old, args.new)),
      { searchHint: "memory edit replace correct update line fix" },
    ),
    tool(
      "memory_append",
      "Add text at the end of a memory file, on a new line. `create: true` makes a new file, only under a journal/ folder (create anything else with memory_write). Only for something the file doesn't hold yet; to change a line, use memory_str_replace.",
      {
        path: z.string().describe('Relative to memory/, e.g. "private/journal/2026-11-27.md".'),
        content: z.string().min(1).describe("The text to add."),
        create: z.boolean().optional().describe("Create the file if it doesn't exist; only under a journal/ folder."),
      },
      async ({ path, content, create }) => run("memory_append", () => deps.store().append(deps.access(), path, content, create === true)),
      { searchHint: "memory append add line journal note" },
    ),
    tool(
      "memory_move",
      "Rename or move a memory file, e.g. into archive/ or into a subfolder. Refused if the destination exists. MEMORY.md files and people records can't be moved.",
      {
        from: z.string().describe("Current path, relative to memory/."),
        to: z.string().describe("New path, relative to memory/."),
      },
      async ({ from, to }) => run("memory_move", () => deps.store().move(deps.access(), from, to)),
      { searchHint: "memory move rename archive folder" },
    ),
    tool(
      "memory_delete",
      "Delete a memory file: when the owner asks you to forget its subject, or everything in it has moved elsewhere. `if_version` as for memory_write. The deleted content is kept for 30 days in Tomo's own data, outside memory; say so when the owner asked you to forget it.",
      {
        path: z.string().describe("Relative to memory/."),
        if_version: z.string().min(1).describe("The version memory_read or memory_list gave you."),
      },
      async ({ path, if_version }) => run("memory_delete", () => deps.store().delete(deps.access(), path, if_version)),
      { searchHint: "memory delete remove forget file" },
    ),
  ];
}
