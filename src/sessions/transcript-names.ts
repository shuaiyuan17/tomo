import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Transcript filename schemes: the injective stem, the legacy stem, and the
 * suffixed sidecar / quarantine names the lazy migration produces.
 */

/**
 * The tail both suffixed-file families share: `-<YYYYMMDD-HHmmss>[-<n>].jsonl`.
 *
 * `-<n>` appears only when two of them would land in the same second, and it
 * sorts after the bare form — so a plain lexicographic sort of these names is
 * chronological, which is what the readers rely on.
 */
const SUFFIXED_FILE_TAIL = String.raw`-\d{8}-\d{6}(?:-\d+)?\.jsonl`;

/** The ledger's own filename; its `.corrupt-<ts>` copies are siblings. */
export const LEGACY_STEM_LEDGER_FILENAME = "_legacy_stems.json";

/**
 * `<base>.legacy-<ts>.jsonl` — a READ-ONLY LEGACY SIDECAR.
 *
 * This is what the migration leaves when the destination filename is already
 * taken: the legacy bytes, renamed once and never rewritten. READERS INCLUDE
 * IT, WRITERS CANNOT SEE IT. `loadTranscript`, `searchTranscript`,
 * `transcriptCreatedAt` and `countRecentUserMessages` read sidecars; `append`,
 * `getLastSeq`, rotation and `archivesForStem` do not — which is what lets the
 * whole pre-migration history stay reachable without renumbering a single
 * `seq`, and keeps seq unique where uniqueness is actually required (inside the
 * active file and its rotation family).
 */
export const LEGACY_SIDECAR_REMAINDER_RE = new RegExp(`^\\.legacy${SUFFIXED_FILE_TAIL}$`);
export const LEGACY_SIDECAR_NAME_RE = new RegExp(`\\.legacy${SUFFIXED_FILE_TAIL}$`);

/**
 * `<base>.ambiguous-<ts>.jsonl` — PRESERVED BUT UNREACHABLE.
 *
 * Only for a key that keeps its legacy stem and turns out to share it: its own
 * active filename IS the mixed file, so "leave it where it is" is not available
 * the way it is for a key that moves. Nothing reads these; they exist so a
 * human can, and so the decision is recorded on disk (see
 * `quarantineAmbiguousFamily` for why that record is load-bearing).
 */
export const AMBIGUOUS_REMAINDER_RE = new RegExp(`^\\.ambiguous${SUFFIXED_FILE_TAIL}$`);
export const AMBIGUOUS_NAME_RE = new RegExp(`\\.ambiguous${SUFFIXED_FILE_TAIL}$`);

/**
 * Is anything in `names` (already lower-cased) named after `stem`?
 *
 * Case-folded, like every other stem comparison here, and deliberately
 * over-inclusive on the archive prefix: `_archive_dm_a_` also matches
 * `_archive_dm_a_b_2026-01.jsonl`, which keeps a ledger row that could have been
 * dropped. Erring toward keeping a row costs a line of JSON; erring the other
 * way costs a collision warning.
 */
export function stemHasFilesOnDisk(stem: string, names: ReadonlySet<string>): boolean {
  const folded = stem.toLowerCase();
  for (const name of names) {
    if (name === `${folded}.jsonl`) return true;
    if (name.startsWith(`${folded}.legacy-`) && name.endsWith(".jsonl")) return true;
    if (name.startsWith(`${folded}.ambiguous-`) && name.endsWith(".jsonl")) return true;
    if (name.startsWith(`_archive_${folded}_`)) return true;
  }
  return false;
}

/** `YYYYMMDD-HHmmss` in UTC: sortable, filename-safe, second resolution. */
export function fileTimestamp(at: Date = new Date()): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${p(at.getUTCFullYear(), 4)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}`
    + `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
}

/**
 * A free `<base>.<kind>-<ts>[-<n>].jsonl` in `dir`, or null when the first
 * hundred candidates are all taken.
 *
 * CHECKED, NOT ASSUMED. The rename that uses this name must never land on an
 * existing sidecar or quarantine file: each one is the only copy of the history
 * inside it, so overwriting one is exactly the loss this whole scheme avoids.
 */
export function freeSuffixedName(dir: string, base: string, kind: "legacy" | "ambiguous"): string | null {
  const ts = fileTimestamp();
  for (let n = 0; n < 100; n++) {
    const name = n === 0 ? `${base}.${kind}-${ts}.jsonl` : `${base}.${kind}-${ts}-${n}.jsonl`;
    const path = join(dir, name);
    if (!existsSync(path)) return path;
  }
  return null;
}

/**
 * The UTC instant encoded in a `-<YYYYMMDD-HHmmss>[-<n>].jsonl` suffix, or null
 * when the name does not carry one. Second resolution, like the names.
 */
export function suffixedNameTime(name: string): number | null {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.jsonl$/.exec(name);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * The filename stem Tomo used for a transcript before the collision fix, and
 * the one it still uses for every key it safely can.
 *
 * MANY-TO-ONE, which is the whole problem: every character outside
 * `[A-Za-z0-9_-]` becomes `_`, so `imessage:any;-;alex.smith@example.com` and
 * `imessage:any;-;alex_smith@example.com` — two different people — name the
 * same file. Kept as a named helper because the lazy migration in
 * `SessionStore` has to be able to find files written under the old scheme.
 */
export function legacyTranscriptFileStem(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Keys made only of these characters keep their legacy stem.
 *
 * `_` is deliberately absent: a `_` in the key is indistinguishable from an
 * encoded `:`, so `dm:a_b` and `dm:a:b` would still collide.
 *
 * `A-Z` IS DELIBERATELY ABSENT TOO, and it is not a nicety. The sessions
 * directory lives on whatever filesystem the user has, and the defaults on
 * both platforms Tomo runs on — APFS on macOS, NTFS on Windows — are
 * case-INSENSITIVE. Allowing uppercase into the unsuffixed family made
 * `imessage:AbC` and `imessage:abc` name the stems `imessage_AbC` and
 * `imessage_abc`, which are the same file there: the exact leak this whole
 * scheme exists to close, reintroduced one letter at a time. Any key with an
 * uppercase character therefore takes the hash suffix, and the hash is what
 * separates it from its case-folded twin (hex digits are lowercase, so the
 * suffix itself survives case folding intact).
 *
 * Nothing everyday moves because of this: `dm:*` keys are lowercased at
 * construction (`dmSessionKeyForIdentity`), `telegram:-100…` and other numeric
 * chat ids have no letters, and `heartbeat` is lowercase. The keys that gain a
 * suffix are the ones that already had to — iMessage chat GUIDs, which carry
 * `;`, `+` or `@` as well.
 */
const LEGACY_STABLE_KEY_CHAR = /[^a-z0-9:-]/;

/** Bits of SHA-256 kept as the disambiguating suffix — 48, i.e. ~16.7M keys
 *  before a 50% birthday chance, against a personal assistant's dozens. */
const KEY_HASH_HEX_CHARS = 12;

/**
 * The filename stem for a session key's transcript: `<stem>.jsonl` for the
 * active file, `_archive_<stem>_<YYYY-MM>.jsonl` for rotation archives.
 *
 * INJECTIVE, which `legacyTranscriptFileStem` is not — and injective UP TO
 * CASE FOLDING, because the filesystem underneath is usually case-insensitive
 * (see `LEGACY_STABLE_KEY_CHAR`):
 *
 * - A key drawn only from `[a-z0-9:-]` keeps its legacy stem, so `dm:alice`,
 *   `telegram:123` and `telegram:-100123` name exactly the files they always
 *   did and never need migrating. On that alphabet the legacy replacement is
 *   `: → _` and identity elsewhere, and `_` is not in the alphabet — so it is
 *   injective there; and every such stem is already lowercase, so folding
 *   changes nothing.
 * - Any other key gets `<legacy stem>.<hash of the FULL key>`. The hash is over
 *   the key, not the stem, so the two iMessage addresses above differ — and so
 *   do two keys differing only in case, whose legacy stems would fold together.
 * - The two sets cannot meet: `.` is outside the legacy safe set, so a legacy
 *   stem never contains one, and a suffixed stem always does.
 *
 * ARCHIVE LISTING DOES NOT RELY ON ANY OF THAT. `_archive_<stem>_` is only a
 * prefix, and `dm:a` is a prefix of `dm:ab` — what stops `dm:a` from claiming
 * `dm:ab`'s archives is the strict remainder test in `archivesForStem`: after
 * the prefix, the name must be exactly `YYYY-MM.jsonl`. A suffixed stem
 * carrying a `.` is neither necessary nor sufficient for that.
 */
export function transcriptFileStem(key: string): string {
  const legacy = legacyTranscriptFileStem(key);
  if (!LEGACY_STABLE_KEY_CHAR.test(key)) return legacy;
  const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, KEY_HASH_HEX_CHARS);
  return `${legacy}.${hash}`;
}
