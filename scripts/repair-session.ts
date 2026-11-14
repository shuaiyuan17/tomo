#!/usr/bin/env tsx
// Repair an SDK session JSONL that was damaged by the pre-fix LCM compactor.
//
// The old compactor only re-parented the first post-range user/assistant event
// after a compaction. Any other post-range event whose parentUuid pointed into
// the removed range became an orphan, and the SDK's timestamp-fallback stitcher
// would silently skip the compact summary during resume.
//
// This script stitches every orphan back into file order: for any event whose
// parentUuid references a UUID not present in the file, the parent is rewritten
// to the nearest preceding event (by file order) that has a UUID.
//
// Usage: npx tsx scripts/repair-session.ts <path-to-session.jsonl>
//        The original file is preserved at <path>.bak before writing.
//
// RELATION TO src/lcm: there is no `tomo lcm` equivalent yet. src/lcm/compact.ts
// no longer produces these orphans, but sessions compacted before that fix
// can only be repaired with this script.
//
// KNOWN ISSUES — read before running. This is an offline maintenance script,
// not part of the build: it is outside tsconfig, has no tests, and does not
// share code with src/lcm. Unlike src/lcm it SILENTLY DROPS every line that
// does not parse as JSON (src/lcm keeps them via
// `parseJsonl(text, { preserveUnparseable: true })`), writes the file in place
// without a temp-file rename, and overwrites any existing <path>.bak. Stop the
// daemon (or make sure the session is not live) and keep your own copy first.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.error("usage: npx tsx scripts/repair-session.ts <path.jsonl>");
  process.exit(1);
}

const raw = readFileSync(path, "utf-8");
const lines = raw.split("\n").filter((l) => l.length > 0);

interface Event { uuid?: string; parentUuid?: string | null; [k: string]: any; }
const events: Event[] = [];
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
}

const uuidSet = new Set<string>();
for (const e of events) if (e.uuid) uuidSet.add(e.uuid);

let fixed = 0;
let firstOrphan = 0;
let lastValidUuid: string | null = null;
const rewrites: { idx: number; from: string; to: string | null }[] = [];

for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (e.parentUuid && !uuidSet.has(e.parentUuid)) {
    if (lastValidUuid === null) firstOrphan++;
    rewrites.push({ idx: i, from: e.parentUuid, to: lastValidUuid });
    e.parentUuid = lastValidUuid;
    fixed++;
  }
  if (e.uuid) lastValidUuid = e.uuid;
}

writeFileSync(path + ".bak", raw);
writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

console.log(`repaired ${fixed} broken parentUuid references (${firstOrphan} had no prior event and were set to null)`);
console.log(`backup: ${path}.bak`);
if (rewrites.length > 0) {
  console.log("first few rewrites:");
  for (const r of rewrites.slice(0, 5)) {
    console.log(`  line ${r.idx}: parentUuid ${r.from.slice(0, 8)} -> ${r.to ? r.to.slice(0, 8) : "null"}`);
  }
}
