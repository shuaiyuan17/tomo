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

You have a file-based memory system at ${MEMORY_DIR}/. This directory is yours — read from it and write to it freely.

## How it works

- **MEMORY.md** is your index file. It's loaded into your context every conversation.
- Each memory is a separate .md file with YAML frontmatter (name, description, type).
- MEMORY.md contains one-line pointers to memory files: \`- [Title](file.md) — short description\`

## Memory types

| Type | Purpose |
|------|---------|
| **user** | Who the user is — role, preferences, knowledge |
| **feedback** | How to approach work — corrections and confirmed approaches |
| **project** | Ongoing work, goals, deadlines |
| **reference** | Pointers to external resources |

## How to save

1. Write the memory file:
\`\`\`markdown
---
name: memory-name
description: one-line description
type: user
---

Memory content here.
\`\`\`

2. Add a pointer to MEMORY.md: \`- [Title](file.md) — one-line hook\`

## When to save

- When the user explicitly asks you to remember something
- When you learn something about the user that would help future conversations
- When the user corrects your approach or confirms a non-obvious choice

## When NOT to save

- Code patterns or architecture (derive from current state)
- Ephemeral task details
- Anything already in SOUL.md, AGENT.md, or IDENTITY.md

## Rules

- Keep MEMORY.md under ${MAX_MEMORY_LINES} lines
- Update or remove stale memories rather than accumulating
- Check if a memory already exists before creating a duplicate
- Convert relative dates to absolute dates when saving`.trim();

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

export function buildSystemPrompt(): string {
  const sections = [load("SOUL"), load("AGENT"), load("IDENTITY"), loadMemory()].filter(Boolean);
  return sections.join("\n\n---\n\n");
}
