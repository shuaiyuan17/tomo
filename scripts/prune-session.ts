#!/usr/bin/env tsx
// Prune tool_result content in an SDK session JSONL, offline, for any path.
// Mirrors src/lcm/prune-tools.ts but takes an explicit file path instead of
// resolving via the tomo config — useful for repairing a session that is too
// big to resume.
//
// Each tool_result block whose content exceeds --min-size bytes is replaced
// with a short stub; parentUuid / uuid / tool_use_id pairings are preserved.
//
// Usage:
//   npx tsx scripts/prune-session.ts <path.jsonl> [--min-size N] [--tools Bash,Edit,Read]
//   Original is saved to <path>.bak.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
const minSize = Number(args.find((a) => a.startsWith("--min-size="))?.split("=")[1] ?? 500);
const toolsArg = args.find((a) => a.startsWith("--tools="))?.split("=")[1];
const toolFilter = toolsArg ? new Set(toolsArg.split(",").map((t) => t.toLowerCase())) : null;

if (!path || !existsSync(path)) {
  console.error("usage: npx tsx scripts/prune-session.ts <path.jsonl> [--min-size=500] [--tools=Bash,Edit,Read]");
  process.exit(1);
}

const raw = readFileSync(path, "utf-8");
const lines = raw.split("\n").filter((l) => l.length > 0);

interface Event { type: string; message?: { content?: any }; toolUseResult?: any; [k: string]: any; }
const events: Event[] = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch { /* skip */ } }

const toolNameById = new Map<string, string>();
for (const e of events) {
  const c = e.message?.content;
  if (!Array.isArray(c)) continue;
  for (const b of c) {
    if (b?.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, b.name);
  }
}

let prunedCount = 0;
let charsRemoved = 0;
const byTool = new Map<string, { count: number; chars: number }>();

for (const e of events) {
  const content = e.message?.content;
  if (!Array.isArray(content)) continue;
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (b?.type !== "tool_result") continue;
    const name = toolNameById.get(b.tool_use_id) ?? "unknown";
    if (toolFilter && !toolFilter.has(name.toLowerCase())) continue;

    const rc = b.content;
    let size: number;
    if (typeof rc === "string") size = rc.length;
    else if (Array.isArray(rc)) size = rc.reduce((s: number, x: any) => s + JSON.stringify(x).length, 0);
    else continue;

    if (size < minSize) continue;

    b.content = `[pruned — ${size.toLocaleString()} chars from ${name}]`;
    prunedCount++;
    charsRemoved += size;
    const prev = byTool.get(name) ?? { count: 0, chars: 0 };
    byTool.set(name, { count: prev.count + 1, chars: prev.chars + size });
  }
}

if (prunedCount === 0) {
  console.log(`no tool_result >= ${minSize} chars found (filter: ${toolsArg ?? "all"})`);
  process.exit(0);
}

writeFileSync(path + ".bak", raw);
writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

console.log(`pruned ${prunedCount} tool_result blocks, ${charsRemoved.toLocaleString()} chars (~${Math.ceil(charsRemoved / 4).toLocaleString()} tokens) removed`);
for (const [name, v] of [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`  ${name}: ${v.count} blocks, ${v.chars.toLocaleString()} chars`);
}
console.log(`backup: ${path}.bak`);
