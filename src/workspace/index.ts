import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOMO_HOME = join(homedir(), ".tomo");
const WORKSPACE_DIR = process.env.TOMO_WORKSPACE ?? join(TOMO_HOME, "workspace");
const DEFAULTS_DIR = resolve(__dirname, "../../defaults");
const MEMORY_DIR = join(WORKSPACE_DIR, "memory");
const MEMORY_ENTRYPOINT = join(MEMORY_DIR, "MEMORY.md");
const MAX_MEMORY_LINES = 200;

/** Load a .md file from workspace, falling back to bundled defaults */
function load(name: string): string {
  const userPath = join(WORKSPACE_DIR, `${name}.md`);
  if (existsSync(userPath)) {
    return readFileSync(userPath, "utf-8").trim();
  }
  const defaultPath = join(DEFAULTS_DIR, `${name}.md`);
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, "utf-8").trim();
  }
  return "";
}

function loadMemory(): string {
  mkdirSync(MEMORY_DIR, { recursive: true });

  const instructions = `
# MEMORY — Your Persistent Memory

You have a file-based memory system at ${MEMORY_DIR}/. This directory is yours — read from it and write to it freely. Build it up actively so future conversations have a complete picture of who the user is, how they like to work, and what's going on in their life.

## How it works

- **MEMORY.md** is your index file. It's loaded into your context every conversation.
- Each memory is a separate .md file with YAML frontmatter (name, description, type).
- MEMORY.md contains one-line pointers: \`- [Title](file.md) — short description\`

## Memory types

**user** — Who the user is. Role, preferences, habits, knowledge, relationships.
- Save when: you learn anything about them — name, job, timezone, likes/dislikes, people they mention, how they communicate
- Example: user says "I'm heading to Tokyo next week" → save travel plans
- Example: user says "my wife thinks..." → save that they have a wife

**feedback** — How you should behave. Both corrections AND confirmed approaches.
- Save when: user corrects you ("don't do that", "not like that") OR confirms something worked ("yes exactly", "perfect"). Watch for quiet confirmations — they're easy to miss.
- Include **why** so you can judge edge cases later.
- Example: user says "stop summarizing, I can read" → save: no trailing summaries

**project** — What's happening in the user's work and life.
- Save when: you learn about goals, deadlines, ongoing work, plans, or context that would help you be more useful
- Convert relative dates to absolute: "next Thursday" → "2026-04-10"
- Example: user mentions "we're launching the app in May" → save with approximate date

**reference** — Where to find things.
- Save when: user mentions external tools, links, services, or resources
- Example: user says "I track bugs in Linear" → save

## How to save

1. Write the memory file (e.g., \`travel.md\`, \`work_context.md\`):
\`\`\`markdown
---
name: descriptive-name
description: one-line summary used to decide relevance
type: user
---

Content here.
\`\`\`

2. Add a pointer to MEMORY.md: \`- [Title](file.md) — one-line hook\`

## Be proactive

Don't wait to be told "remember this." Actively notice when the user shares something worth keeping. Save it silently — don't announce "I'm saving this to memory" unless they asked you to remember something explicitly.

Signals to watch for:
- Personal details (name, location, job, family, preferences)
- Opinions and preferences ("I prefer X", "I hate Y")
- Corrections to your behavior (save as feedback)
- Confirmations of your approach (save as feedback too — you need both)
- Life events, travel, deadlines, plans
- Tools, services, workflows they use

## When NOT to save

- Trivial ephemeral details ("what's the weather")
- Things already in your personality files
- Raw conversation transcripts

## Rules

- Keep MEMORY.md under ${MAX_MEMORY_LINES} lines
- Update existing memories rather than creating duplicates — check first
- Remove stale memories when you notice they're outdated
- Organize by topic, not chronology`.trim();

  let memoryContent: string;
  if (existsSync(MEMORY_ENTRYPOINT)) {
    const raw = readFileSync(MEMORY_ENTRYPOINT, "utf-8").trim();
    const lines = raw.split("\n");
    if (lines.length > MAX_MEMORY_LINES) {
      memoryContent = lines.slice(0, MAX_MEMORY_LINES).join("\n") + `\n\n(truncated — ${lines.length - MAX_MEMORY_LINES} lines omitted)`;
    } else {
      memoryContent = raw;
    }
  } else {
    memoryContent = "(currently empty)";
  }

  return `${instructions}\n\n## Current MEMORY.md\n\n${memoryContent}`;
}

const HARNESS_INSTRUCTIONS = `
# HARNESS — Internal Rules (not user-editable)

## Message Format

You receive messages from the user through messaging channels (Telegram, etc). Messages prefixed with \`System:\` are from the harness, not a human.

## Silent Replies

If you determine that no message needs to be sent to the user (e.g., background task found nothing to report, internal maintenance), reply with exactly:

\`\`\`
NO_REPLY
\`\`\`

This suppresses delivery to the channel. Never use NO_REPLY when the user asked you a direct question or requested a reminder.
`.trim();

export function buildSystemPrompt(): string {
  const sections = [load("SOUL"), load("AGENT"), load("IDENTITY"), loadMemory(), HARNESS_INSTRUCTIONS].filter(Boolean);
  return sections.join("\n\n---\n\n");
}
