#!/usr/bin/env tsx
// Offline LCM compact against an SDK session JSONL at any path.
// Same logic as src/lcm/compact.ts (post-fix), but resolves the range by
// absolute timestamp and reads the summary from a file — so you can compact
// a session that is too big to resume through tomo's agent.
//
// Usage:
//   npx tsx scripts/compact-session.ts <path.jsonl> <from-iso> <to-iso> <summary.txt>
//
// <from-iso>/<to-iso> are passed to new Date(). Local time assumed when tz
// is omitted. The range is inclusive on both ends, measured against each
// user/assistant event's timestamp. The summary event's parentUuid is set
// to the pre-range event's parentUuid, and every post-range event whose
// parentUuid is in the removed set is re-pointed at the summary.
//
// Backup saved to <path>.bak.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [, , path, fromISO, toISO, summaryPath] = process.argv;
if (!path || !fromISO || !toISO || !summaryPath || !existsSync(path) || !existsSync(summaryPath)) {
  console.error("usage: npx tsx scripts/compact-session.ts <path.jsonl> <from-iso> <to-iso> <summary.txt>");
  process.exit(1);
}

const fromMs = new Date(fromISO).getTime();
const toMs = new Date(toISO).getTime();
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
  console.error("invalid time range");
  process.exit(1);
}
const summary = readFileSync(summaryPath, "utf-8").trim();
if (!summary) { console.error("summary is empty"); process.exit(1); }

const raw = readFileSync(path, "utf-8");
const lines = raw.split("\n").filter((l) => l.length > 0);

interface Event { type: string; uuid?: string; parentUuid?: string | null; timestamp?: string; [k: string]: any; }
const events: Event[] = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }

const convIndices: number[] = [];
for (let i = 0; i < events.length; i++) {
  const t = events[i].type;
  if (t === "user" || t === "assistant") convIndices.push(i);
}

let fromGlobal = -1, toGlobal = -1;
for (const gi of convIndices) {
  const ts = events[gi].timestamp ? new Date(events[gi].timestamp!).getTime() : NaN;
  if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
  if (fromGlobal === -1) fromGlobal = gi;
  toGlobal = gi;
}
if (fromGlobal === -1) { console.error("no user/assistant events found in range"); process.exit(1); }

const removeSet = new Set<number>();
for (let i = fromGlobal; i <= toGlobal; i++) removeSet.add(i);

const removedUuids = new Set<string>();
for (const idx of removeSet) { const u = events[idx].uuid; if (u) removedUuids.add(u); }

const first = events[fromGlobal];
const summaryUuid = randomUUID();
const summaryEvent: Event = {
  parentUuid: first.parentUuid ?? null,
  type: "user",
  message: { role: "user", content: `[Compacted section — ${removeSet.size} events summarized]\n\n${summary}` },
  uuid: summaryUuid,
  isSidechain: false,
  isCompactSummary: true,
  timestamp: first.timestamp,
  sessionId: first.sessionId,
  userType: first.userType ?? "external",
  entrypoint: first.entrypoint ?? "sdk-ts",
  cwd: first.cwd ?? "",
  version: first.version ?? "2.1.94",
  gitBranch: first.gitBranch ?? "HEAD",
  slug: first.slug ?? "",
};

const newEvents: Event[] = [];
for (let i = 0; i < fromGlobal; i++) newEvents.push(events[i]);
newEvents.push(summaryEvent);
for (let i = toGlobal + 1; i < events.length; i++) {
  const e = { ...events[i] };
  if (e.parentUuid && removedUuids.has(e.parentUuid)) e.parentUuid = summaryUuid;
  newEvents.push(e);
}

writeFileSync(path + ".bak", raw);
writeFileSync(path, newEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");

const charsBefore = raw.length;
const charsAfter = newEvents.map((e) => JSON.stringify(e)).join("\n").length + 1;
console.log(`compacted ${removeSet.size} events (conv range ${fromGlobal}-${toGlobal})`);
console.log(`chars: ${charsBefore.toLocaleString()} -> ${charsAfter.toLocaleString()} (-${(charsBefore - charsAfter).toLocaleString()}, ~-${Math.ceil((charsBefore - charsAfter) / 4).toLocaleString()} tokens)`);
console.log(`summary uuid: ${summaryUuid}`);
console.log(`backup: ${path}.bak`);
