import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The workspace files are copied once, at init (CONTINUITY.md at start when
// missing), and are the owner's from then on: a later Tomo never updates
// them. So they hold personality and personal habits only; how Tomo works
// (tools, routing, delivery, summoning) lives in code-side prompts and tool
// descriptions, which every install gets on upgrade.
const DEFAULTS = join(import.meta.dirname, "..", "defaults");
const FILES = ["SOUL.md", "AGENT.md", "IDENTITY.md", "CONTINUITY.md"];
const MECHANICS = [
  /\b(list_sessions|send_message|rename_group_chat|react_to_message|edit_message|task_spawn|recall_conversation)\b/,
  /\b(task|schedule)_[a-z]+\b|\bupsert_person\b|\blist_people\b/,
  /\bNO_REPLY\b|\bMEDIA:|\bSTICKER:/,
  /\/summon|\/dismiss|tomo-event/,
  /\bevery ~?\d+ minutes\b/,
  /\bmemory_[a-z]+\b/,
];

describe("the bundled workspace files", () => {
  it.each(FILES)("%s carries no instruction on how Tomo works", (file) => {
    const text = readFileSync(join(DEFAULTS, file), "utf8");
    for (const pattern of MECHANICS) expect(text).not.toMatch(pattern);
  });
});
