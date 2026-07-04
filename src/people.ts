import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { defaultRuntimePaths } from "./runtime-paths.js";
import { log } from "./logger.js";

/**
 * People registry — structured identity records for the humans in the user's
 * life. One markdown file per person with simple `key: value` frontmatter and
 * freeform notes below. The harness resolves group-chat senders against these
 * records deterministically (stable channel ids first, then names/aliases), so
 * recognition doesn't depend on the model remembering to consult memory.
 *
 * Layout:
 * - `<workspace>/memory/people/` — normal records, visible everywhere.
 * - `<workspace>/memory/private/people/` — DM-only records. They live under
 *   the existing private memory subtree, so the group-session guard hook
 *   already blocks file reads and we exclude them from group prompts here.
 */

export interface PersonRecord {
  /** Canonical display name. */
  name: string;
  /** Alternate names / nicknames, any language. */
  aliases: string[];
  /** channel name → stable sender id (telegram user id, imessage address). */
  handles: Record<string, string>;
  /** Unrecognized frontmatter keys, preserved verbatim on rewrite. */
  extra: Record<string, string>;
  /** Freeform notes below the frontmatter. Never injected into group prompts. */
  notes: string;
  /** Absolute path of the backing file. */
  filePath: string;
  /** True when the record lives under memory/private/people/. */
  isPrivate: boolean;
}

export interface PeopleDirs {
  publicDir: string;
  privateDir: string;
}

/** Channels whose frontmatter key is treated as a handle binding. */
export const HANDLE_CHANNELS = ["telegram", "imessage"] as const;

const RESERVED_KEYS = new Set(["name", "aliases", ...HANDLE_CHANNELS]);
/** Skip pathological files rather than pulling megabytes into every prompt build. */
const MAX_PERSON_FILE_BYTES = 64 * 1024;
const MAX_PEOPLE_FILES = 500;

export function defaultPeopleDirs(): PeopleDirs {
  const memoryDir = join(defaultRuntimePaths.workspaceDir, "memory");
  return {
    publicDir: join(memoryDir, "people"),
    privateDir: join(memoryDir, "private", "people"),
  };
}

/** Normalize a handle the same way channels normalize sender ids, so a
 *  hand-written `imessage: +1 (415) 555-1234` still matches the wire form. */
export function normalizeHandle(channel: string, value: string): string {
  const v = value.trim();
  if (channel === "imessage") {
    if (v.includes("@")) return v.toLowerCase();
    return v.replace(/[^\d+]/g, "");
  }
  return v;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function parseAliases(raw: string): string[] {
  let v = stripQuotes(raw);
  // Tolerate the YAML inline-array form the memory instructions use elsewhere.
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  return v
    .split(/[,、，]/)
    .map((a) => stripQuotes(a))
    .filter(Boolean);
}

/** Parse one person file. Exported for tests. Returns undefined when the file
 *  has no usable frontmatter `name:` — malformed files are skipped, not fatal. */
export function parsePersonFile(content: string, filePath: string, isPrivate: boolean): PersonRecord | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return undefined;

  const record: PersonRecord = {
    name: "",
    aliases: [],
    handles: {},
    extra: {},
    notes: lines.slice(end + 1).join("\n").trim(),
    filePath,
    isPrivate,
  };

  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === "name") record.name = stripQuotes(value);
    else if (key === "aliases") record.aliases = parseAliases(value);
    else if ((HANDLE_CHANNELS as readonly string[]).includes(key)) {
      const v = stripQuotes(value);
      if (v) record.handles[key] = v;
    } else if (value.trim()) record.extra[key] = value.trim();
  }

  return record.name ? record : undefined;
}

/** Serialize a record back to file content. Exported for tests. */
export function serializePersonRecord(record: PersonRecord): string {
  const front = [`name: ${record.name}`];
  if (record.aliases.length > 0) front.push(`aliases: ${record.aliases.join(", ")}`);
  for (const channel of HANDLE_CHANNELS) {
    const v = record.handles[channel];
    if (v) front.push(`${channel}: ${v}`);
  }
  for (const [key, value] of Object.entries(record.extra)) {
    if (!RESERVED_KEYS.has(key)) front.push(`${key}: ${value}`);
  }
  return `---\n${front.join("\n")}\n---\n${record.notes ? `\n${record.notes}\n` : ""}`;
}

function loadDir(dir: string, isPrivate: boolean, budget: { remaining: number }): PersonRecord[] {
  if (!existsSync(dir)) return [];
  const records: PersonRecord[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    log.warn({ err, dir }, "Failed to read people directory");
    return [];
  }
  for (const file of files) {
    if (budget.remaining <= 0) break;
    const filePath = join(dir, file);
    try {
      if (statSync(filePath).size > MAX_PERSON_FILE_BYTES) {
        log.warn({ filePath }, "Skipping oversized person file");
        continue;
      }
      const parsed = parsePersonFile(readFileSync(filePath, "utf-8"), filePath, isPrivate);
      if (parsed) {
        records.push(parsed);
        budget.remaining--;
      }
    } catch (err) {
      log.warn({ err, filePath }, "Failed to read person file");
    }
  }
  return records;
}

/** Load all person records. Group-session callers must pass
 *  `includePrivate: false` so private people never leak into group flows. */
export function loadPeople(opts: { includePrivate: boolean; dirs?: PeopleDirs }): PersonRecord[] {
  const dirs = opts.dirs ?? defaultPeopleDirs();
  const budget = { remaining: MAX_PEOPLE_FILES };
  const records = loadDir(dirs.publicDir, false, budget);
  if (opts.includePrivate) records.push(...loadDir(dirs.privateDir, true, budget));
  return records;
}

export function findPersonByHandle(people: PersonRecord[], channel: string, senderId: string): PersonRecord | undefined {
  const target = normalizeHandle(channel, senderId);
  return people.find((p) => {
    const h = p.handles[channel];
    return h !== undefined && normalizeHandle(channel, h) === target;
  });
}

/** All records whose canonical name or an alias matches (case/space-insensitive). */
export function findPeopleByName(people: PersonRecord[], name: string): PersonRecord[] {
  const target = normalizeName(name);
  if (!target) return [];
  return people.filter(
    (p) => normalizeName(p.name) === target || p.aliases.some((a) => normalizeName(a) === target),
  );
}

/** Single unambiguous name match — undefined when zero or multiple records match. */
export function findPersonByName(people: PersonRecord[], name: string): PersonRecord | undefined {
  const matches = findPeopleByName(people, name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Collapse a display name to its letters/numbers (any script) so decorated
 *  profile names ("kw 🚀", "阿丽✨") can match a plain alias. */
function strippedName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Refuse to fuzzy-match on a single character — "K." matching alias "k"
 *  is far more likely to be a different person than a decoration. */
const MIN_STRIPPED_MATCH_CHARS = 2;

/**
 * Display-name resolution for wire names: exact name/alias match first; when
 * nothing matches exactly, fall back to comparing with decorations (emoji,
 * symbols, punctuation) stripped from BOTH sides. Each stage requires a
 * unique match — an exact-stage ambiguity does not fall through to the
 * looser stage. Deliberately NOT used by upsertPerson, whose `match` must
 * stay exact so the tool never fuzzy-edits the wrong record.
 */
export function findPersonByDisplayName(people: PersonRecord[], name: string): PersonRecord | undefined {
  const exact = findPeopleByName(people, name);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;

  const target = strippedName(name);
  if (target.length < MIN_STRIPPED_MATCH_CHARS) return undefined;
  const stripped = people.filter(
    (p) => strippedName(p.name) === target || p.aliases.some((a) => strippedName(a) === target),
  );
  return stripped.length === 1 ? stripped[0] : undefined;
}

/** Resolve a sender to a person: stable handle first, then unambiguous name/alias. */
export function resolveSender(
  people: PersonRecord[],
  channel: string,
  senderName: string,
  senderId?: string,
): PersonRecord | undefined {
  if (senderId) {
    const byHandle = findPersonByHandle(people, channel, senderId);
    if (byHandle) return byHandle;
  }
  return findPersonByDisplayName(people, senderName);
}

/**
 * Sender prefix for group transcript lines: the wire display name, annotated
 * with the canonical name when they differ — `kw 🚀 (Kevin Wang)`. Keeps the
 * name the group actually sees first (that's who Tomo should address) while
 * making the identity join explicit on every message.
 */
export function annotateSenderName(
  people: PersonRecord[],
  channel: string,
  senderName: string,
  senderId?: string,
): string {
  const person = resolveSender(people, channel, senderName, senderId);
  if (!person || normalizeName(person.name) === normalizeName(senderName)) return senderName;
  return `${senderName} (${person.name})`;
}

function slugForName(name: string): string {
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || "person";
}

export function savePersonRecord(record: PersonRecord): void {
  mkdirSync(dirname(record.filePath), { recursive: true });
  writeFileSync(record.filePath, serializePersonRecord(record), "utf-8");
}

export interface UpsertPersonInput {
  /** Canonical name to set (and to match on when `match` is omitted). */
  name: string;
  /** Existing name/alias to locate the record — pass when renaming. */
  match?: string;
  aliases?: string[];
  /** Replace the alias list instead of merging into it. */
  replaceAliases?: boolean;
  telegram?: string;
  imessage?: string;
  /** Replaces the freeform notes body when provided. */
  notes?: string;
  /** Create the record under the private (DM-only) subtree. */
  isPrivate?: boolean;
}

export interface UpsertPersonResult {
  record: PersonRecord;
  created: boolean;
}

/**
 * Create or update a person record. Matching is by `match` (or `name`) against
 * canonical names and aliases of the loaded scope. Throws on ambiguity so a
 * caller never silently edits the wrong friend.
 */
export function upsertPerson(
  input: UpsertPersonInput,
  opts: { includePrivate: boolean; dirs?: PeopleDirs },
): UpsertPersonResult {
  const dirs = opts.dirs ?? defaultPeopleDirs();
  const people = loadPeople({ includePrivate: opts.includePrivate, dirs });
  const matchKey = input.match ?? input.name;
  const matches = findPeopleByName(people, matchKey);
  if (matches.length > 1) {
    throw new Error(
      `"${matchKey}" matches ${matches.length} people (${matches.map((p) => p.name).join(", ")}) — use a more specific \`match\`.`,
    );
  }

  let record = matches[0];
  let created = false;
  if (!record) {
    const dir = input.isPrivate ? dirs.privateDir : dirs.publicDir;
    mkdirSync(dir, { recursive: true });
    let file = `${slugForName(input.name)}.md`;
    for (let i = 2; existsSync(join(dir, file)); i++) file = `${slugForName(input.name)}-${i}.md`;
    record = {
      name: input.name,
      aliases: [],
      handles: {},
      extra: {},
      notes: "",
      filePath: join(dir, file),
      isPrivate: !!input.isPrivate,
    };
    created = true;
  } else if (input.isPrivate !== undefined && input.isPrivate !== record.isPrivate) {
    // Move between public/private subtrees, keeping the filename.
    const dir = input.isPrivate ? dirs.privateDir : dirs.publicDir;
    mkdirSync(dir, { recursive: true });
    let file = basename(record.filePath);
    for (let i = 2; existsSync(join(dir, file)); i++) {
      file = `${basename(record.filePath, ".md")}-${i}.md`;
    }
    const newPath = join(dir, file);
    renameSync(record.filePath, newPath);
    record.filePath = newPath;
    record.isPrivate = input.isPrivate;
  }

  const previousName = record.name;
  record.name = input.name;
  const merged = input.aliases
    ? (input.replaceAliases ? [...input.aliases] : [...record.aliases, ...input.aliases])
    : [...record.aliases];
  // On a rename, keep the old canonical name reachable as an alias.
  if (!created && normalizeName(previousName) !== normalizeName(input.name)) {
    merged.push(previousName);
  }
  const seen = new Set<string>();
  record.aliases = merged.filter((a) => {
    const key = normalizeName(a);
    if (!key || key === normalizeName(record.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (input.telegram !== undefined) record.handles.telegram = input.telegram.trim();
  if (input.imessage !== undefined) record.handles.imessage = normalizeHandle("imessage", input.imessage);
  for (const channel of HANDLE_CHANNELS) {
    if (record.handles[channel] === "") delete record.handles[channel];
  }
  if (input.notes !== undefined) record.notes = input.notes.trim();

  savePersonRecord(record);
  return { record, created };
}

/**
 * Harness-side handle learning: when a sender's display name unambiguously
 * matches exactly one person who has no handle bound for this channel yet,
 * bind the stable id automatically. This is what lets users describe people
 * by name/nickname only and still get id-stable recognition — nobody knows
 * their friends' Telegram user ids offhand. A person that already has a
 * different handle bound keeps it (guards against a second person adopting
 * an existing friend's display name).
 *
 * Binding fires on group traffic, so candidates are PUBLIC records only — a
 * group display-name collision must never mutate a private (DM-only) record.
 * The "already bound?" pre-check still scans private records, so an id owned
 * by a private person can't get double-bound onto a same-named public one.
 * Consequence: private records never auto-bind; their handles are set
 * explicitly via upsert_person from a DM.
 */
export function autoBindHandle(
  channel: string,
  senderId: string,
  senderName: string,
  dirs?: PeopleDirs,
): PersonRecord | undefined {
  try {
    if (!(HANDLE_CHANNELS as readonly string[]).includes(channel)) return undefined;
    const all = loadPeople({ includePrivate: true, dirs });
    if (findPersonByHandle(all, channel, senderId)) return undefined;
    const person = findPersonByDisplayName(all.filter((p) => !p.isPrivate), senderName);
    if (!person || person.handles[channel]) return undefined;
    person.handles[channel] = normalizeHandle(channel, senderId);
    savePersonRecord(person);
    log.info({ person: person.name, channel, senderId }, "Auto-bound sender handle to person record");
    return person;
  } catch (err) {
    log.warn({ err, channel, senderId }, "autoBindHandle failed");
    return undefined;
  }
}

/**
 * Render group participants as identity-resolved labels for the system prompt,
 * e.g. `Kevin Wang (aka: kw, 嘉伟; appears as "kw 🚀")`. Sender-id groupings
 * from the session registry are joined against the people registry; names that
 * never arrived with an id are matched by name/alias as a fallback.
 */
export function renderParticipantLabels(opts: {
  channelName: string;
  participants: string[];
  participantIds?: Record<string, string[]>;
  people: PersonRecord[];
}): string[] {
  const { channelName, participants, participantIds = {}, people } = opts;
  const labels: string[] = [];
  const covered = new Set<string>();
  const labeledPeople = new Set<PersonRecord>();

  const labelFor = (person: PersonRecord | undefined, namesSeen: string[]): string => {
    const latest = namesSeen[namesSeen.length - 1];
    if (!person) {
      const earlier = namesSeen.slice(0, -1);
      return earlier.length > 0 ? `${latest} (also seen as: ${earlier.join(", ")})` : latest;
    }
    const details: string[] = [];
    if (person.aliases.length > 0) details.push(`aka: ${person.aliases.join(", ")}`);
    if (latest && normalizeName(latest) !== normalizeName(person.name)) {
      details.push(`appears as "${latest}"`);
    }
    return details.length > 0 ? `${person.name} (${details.join("; ")})` : person.name;
  };

  for (const [senderId, names] of Object.entries(participantIds)) {
    if (names.length === 0) continue;
    for (const n of names) covered.add(n);
    const person =
      findPersonByHandle(people, channelName, senderId) ??
      names.map((n) => findPersonByDisplayName(people, n)).find(Boolean);
    if (person) {
      if (labeledPeople.has(person)) continue;
      labeledPeople.add(person);
    }
    labels.push(labelFor(person, names));
  }

  for (const name of participants) {
    if (covered.has(name)) continue;
    const person = findPersonByDisplayName(people, name);
    if (person) {
      if (labeledPeople.has(person)) continue;
      labeledPeople.add(person);
    }
    labels.push(labelFor(person, [name]));
  }

  return labels;
}

/** One roster line per person — names and aliases only, no handles or notes. */
export function renderPeopleRoster(people: PersonRecord[]): string[] {
  return people.map((p) =>
    p.aliases.length > 0 ? `- ${p.name} — aka: ${p.aliases.join(", ")}` : `- ${p.name}`,
  );
}
