import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadPeople, upsertPerson, type PeopleDirs } from "../people.js";

export interface PeopleToolDeps {
  /**
   * False for group sessions: private people records are then invisible to
   * both tools — not listed, not matchable, not creatable.
   */
  includePrivate: boolean;
  /** Test override for the registry location. */
  dirs?: PeopleDirs;
}

const NOTES_EXCERPT_CHARS = 500;

/**
 * MCP tools over the people registry (see src/people.ts). The registry is
 * plain markdown the agent could edit directly — these tools exist so routine
 * updates ("kw is Kevin's nickname") keep the frontmatter well-formed and are
 * matched against existing records instead of creating near-duplicates.
 */
export function buildPeopleTools(deps: PeopleToolDeps) {
  return [
    tool(
      "list_people",
      [
        "List the people registry: everyone recorded in memory/people/ with their canonical name, aliases/nicknames, bound channel handles, and a notes excerpt.",
        "",
        "Use it before upsert_person (to check whether a person already exists under another name) and whenever you need to recall who a nickname refers to beyond what the system prompt roster shows.",
      ].join("\n"),
      {},
      async () => {
        const people = loadPeople({ includePrivate: deps.includePrivate, dirs: deps.dirs });
        const listing = people.map((p) => ({
          name: p.name,
          aliases: p.aliases,
          handles: p.handles,
          ...(p.isPrivate ? { private: true } : {}),
          file: p.filePath,
          notes: p.notes.length > NOTES_EXCERPT_CHARS
            ? `${p.notes.slice(0, NOTES_EXCERPT_CHARS)}… [truncated — read the file for the rest]`
            : p.notes,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(listing, null, 2) }],
        };
      },
      {
        alwaysLoad: true,
        searchHint: "list people registry contacts friends aliases nicknames handles who is",
      },
    ),
    tool(
      "upsert_person",
      [
        "Create or update a person record in the people registry. Matches an existing record by `match` (or by `name` when `match` is omitted) against canonical names AND aliases, so updating by nickname works.",
        "",
        "Use whenever you learn identity facts: a new nickname (\"kw is Kevin\"), a person's real name, or notes worth keeping about them. Aliases are merged into the existing list unless `replace_aliases` is set; `notes` replaces the record's freeform body when provided.",
        "",
        "Channel handles (telegram user id, imessage address) are bound automatically by the harness when a matching sender appears in a chat — only pass `telegram`/`imessage` to correct a wrong binding.",
      ].join("\n"),
      {
        name: z.string().min(1).max(200).describe(
          "Canonical display name for the person. Renames the record when it differs from the matched record's current name (the old name is kept as an alias).",
        ),
        match: z.string().min(1).max(200).optional().describe(
          "Existing name or alias identifying which record to update. Omit to match by `name`. A non-matching value creates a new record under `name`.",
        ),
        aliases: z.array(z.string().min(1).max(200)).max(50).optional().describe(
          "Nicknames / alternate names to add (any language). Merged with existing aliases unless `replace_aliases` is true.",
        ),
        replace_aliases: z.boolean().default(false).describe(
          "Replace the whole alias list with `aliases` instead of merging. Use to remove a wrong alias.",
        ),
        telegram: z.string().max(64).optional().describe(
          "Telegram user id to bind. Pass an empty string to clear the binding.",
        ),
        imessage: z.string().max(200).optional().describe(
          "iMessage handle (phone or email) to bind. Pass an empty string to clear the binding.",
        ),
        notes: z.string().max(20000).optional().describe(
          "Freeform notes body — REPLACES the existing notes entirely, so include anything worth keeping from the old notes (see list_people first).",
        ),
        private: z.boolean().optional().describe(
          "true moves/creates the record under memory/private/people/ (DM-only; invisible to group sessions). Only usable from DM sessions.",
        ),
      },
      async ({ name, match, aliases, replace_aliases, telegram, imessage, notes, private: isPrivate }) => {
        if (isPrivate !== undefined && !deps.includePrivate) {
          return {
            content: [{ type: "text" as const, text: "upsert_person failed: the `private` flag can only be used from a DM session." }],
            isError: true,
          };
        }
        try {
          const { record, created } = upsertPerson(
            {
              name,
              match,
              aliases,
              replaceAliases: replace_aliases,
              telegram,
              imessage,
              notes,
              isPrivate,
            },
            { includePrivate: deps.includePrivate, dirs: deps.dirs },
          );
          const summary = {
            name: record.name,
            aliases: record.aliases,
            handles: record.handles,
            ...(record.isPrivate ? { private: true } : {}),
            file: record.filePath,
          };
          return {
            content: [{
              type: "text" as const,
              text: `${created ? "Created" : "Updated"} person record:\n${JSON.stringify(summary, null, 2)}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `upsert_person failed: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
      {
        alwaysLoad: true,
        searchHint: "save person contact friend nickname alias real name remember who someone is",
      },
    ),
  ];
}
