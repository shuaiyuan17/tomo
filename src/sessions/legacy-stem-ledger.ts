/**
 * The legacy stem ownership ledger (`_legacy_stems.json`, see
 * LegacyStemLedgerFile): which keys have owned each legacy transcript stem,
 * kept on disk so a migration can still see an owner after the registry has
 * forgotten it, plus the quarantine of a ledger (or rows of one) that will not
 * parse.
 *
 * Its lock is always the innermost one: SessionStore takes it with the
 * registry or transcript lock already held, never the other way round, and
 * nothing here takes either of those.
 */
import { readFileSync, existsSync, renameSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { withFileLockSync, type FileLockOptions } from "../file-lock.js";
import { legacyTranscriptFileStem, LEGACY_STEM_LEDGER_FILENAME, stemHasFilesOnDisk, fileTimestamp } from "./transcript-names.js";
import { NO_CORRUPT_LEDGER_HOLD, type LegacyStemLedgerFile, type CorruptLedgerHold } from "./store-support.js";

export class LegacyStemLedger {
  private readonly dir: string;
  private readonly readOnly: boolean;
  private readonly ledgerLockOptions: FileLockOptions;
  /** The ledger's read failure is logged once per streak, not once per key. */
  private legacyStemLedgerErrorLogged = false;
  /** Case-folded legacy stems whose ledger ROW could not be parsed. Their
   *  ownership is unknown, so only their migrations defer — the rest of the
   *  ledger is still good evidence (see `load`). */
  private legacyStemLedgerMalformedStems = new Set<string>();
  /** The whole ledger file was unparseable and has been moved aside. Fail
   *  closed for the rest of the streak: the file is ABSENT now, and "absent"
   *  otherwise reads as "fresh install, nothing was ever shared". */
  private legacyStemLedgerUnparseable = false;
  /** One row-healing attempt per streak, not one per key touch. */
  private legacyStemLedgerHealAttempted = false;
  /**
   * The last `_legacy_stems.json.corrupt-*` scan, keyed by a signature over the
   * copies' names, sizes and mtimes.
   *
   * DERIVED FROM THE DIRECTORY, NEVER REMEMBERED ACROSS THE FACT: the hold those
   * copies place on a stem has to outlive the process that created them (see
   * `corruptLegacyStemLedgerHold`), and it is released by an operator deleting
   * or repairing the file — which the signature notices.
   */
  private legacyStemLedgerCorruptCache: { signature: string; hold: CorruptLedgerHold } | null = null;

  constructor(opts: { dir: string; readOnly: boolean; lockOptions: FileLockOptions }) {
    this.dir = opts.dir;
    this.readOnly = opts.readOnly;
    this.ledgerLockOptions = opts.lockOptions;
  }

  /** A case-folded stem whose ledger row could not be parsed in this process. */
  isMalformedStem(stem: string): boolean {
    return this.legacyStemLedgerMalformedStems.has(stem);
  }

  /** The directory's entry names; empty when it cannot be read. */
  private dirNames(): string[] {
    try {
      return readdirSync(this.dir);
    } catch {
      return [];
    }
  }
  get path(): string {
    return join(this.dir, LEGACY_STEM_LEDGER_FILENAME);
  }

  /** Advisory lock for the ledger's read-modify-write.
   *
   *  ALWAYS THE INNERMOST LOCK. The registry lock and the transcript lock are
   *  both taken with this one still free, and nothing here reaches back for
   *  either, so the acquisition order is fixed (registry → transcript →
   *  ledger) and no two processes can build a cycle. */
  private get legacyStemLedgerLockPath(): string {
    return `${this.path}.lock`;
  }

  /**
   * Legacy stem → owning keys, as recorded on disk.
   *
   * ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS, and this is the one place in
   * the store where getting that wrong costs someone else's history: a missing
   * file legitimately means "nothing has been recorded yet", while a file that
   * exists and will not parse may name the very owner that makes a legacy
   * transcript ambiguous. So the second case says so, and every caller refuses
   * rather than proceeding on `{}`. Never throws — this runs under `get()`.
   *
   * A MALFORMED ROW IS NOT A MALFORMED FILE. The first version refused the whole
   * file for one bad row, which deferred EVERY key's migration, and the write
   * path then quarantined the file and rebuilt from `{}` — discarding the
   * ownership evidence in all the rows that were perfectly readable. Rows are
   * parsed one at a time now: the good ones are returned and used, the bad ones
   * are reported in `malformed` so that only THEIR stems defer, and
   * `healLegacyStemLedgerRows` moves them verbatim into a `.corrupt-<ts>`
   * sibling so the wedge clears without waiting for a write.
   *
   * PURE, DELIBERATELY: callers may hold locks or be mid-cycle, so nothing is
   * written from here. The read path triggers the healing explicitly.
   */
  load():
    { ok: true; stems: Record<string, string[]>; malformed: string[] } | { ok: false } {
    if (this.legacyStemLedgerUnparseable && !existsSync(this.path)) {
      // The bytes were moved to `.corrupt-<ts>` on the read path, so the file is
      // absent now — and "absent" is the one answer we must not give here, since
      // it reads as "nothing was ever recorded". Fail closed until a ledger that
      // parses is back in place.
      return { ok: false };
    }
    if (!existsSync(this.path)) return { ok: true, stems: {}, malformed: [] };
    let data: Partial<LegacyStemLedgerFile>;
    try {
      data = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<LegacyStemLedgerFile>;
    } catch (err) {
      this.noteLegacyStemLedgerUnreadable(err);
      return { ok: false };
    }
    const stems = data?.stems;
    if (!stems || typeof stems !== "object" || Array.isArray(stems)) {
      this.noteLegacyStemLedgerUnreadable(new Error("missing or malformed `stems` object"));
      return { ok: false };
    }
    const good: Record<string, string[]> = {};
    const malformed: string[] = [];
    for (const [stem, owners] of Object.entries(stems)) {
      if (Array.isArray(owners) && owners.every((key) => typeof key === "string")) {
        good[stem] = owners as string[];
        continue;
      }
      malformed.push(stem);
      // Remembered for the rest of the process: the healing below takes the row
      // out of the file, and after that nothing on disk says this stem's owners
      // were once unreadable. Its migrations keep deferring here rather than
      // adopting a file whose other owner may be exactly what that row held.
      this.legacyStemLedgerMalformedStems.add(stem.toLowerCase());
    }
    if (malformed.length > 0) {
      this.noteLegacyStemLedgerUnreadable(
        new Error(`malformed owner list for ${malformed.length} stem(s): ${malformed.map((x) => JSON.stringify(x)).join(", ")}`),
      );
    } else {
      this.legacyStemLedgerErrorLogged = false;
      this.legacyStemLedgerHealAttempted = false;
      this.legacyStemLedgerUnparseable = false;
    }
    return { ok: true, stems: good, malformed };
  }

  /**
   * The ledger as the OWNERSHIP PROBE reads it: the same parse, plus the two
   * repairs that can only safely be attempted from a path that is not already
   * mid-write.
   *
   * This is the read path the brief calls for. A wedged ledger used to sit there
   * until some write path happened to come along — and since the write paths
   * refuse when the ledger is unreadable, "some write path" could be never.
   */
  read():
    { ok: true; stems: Record<string, string[]>; malformed: string[] } | { ok: false } {
    const loaded = this.load();
    if (this.readOnly) return loaded;
    if (loaded.ok && loaded.malformed.length === 0) return loaded;
    if (loaded.ok) {
      if (!this.healLegacyStemLedgerRows()) return loaded;
      const reread = this.load();
      // The stems whose rows were bad stay in `legacyStemLedgerMalformedStems`,
      // so they keep deferring even though the re-read no longer lists them.
      return reread.ok ? { ...reread, malformed: loaded.malformed } : reread;
    }
    this.quarantineUnparseableLedger();
    return { ok: false };
  }

  /**
   * Move every unparseable ROW into a `.corrupt-<ts>` sibling and rewrite the
   * good ones, atomically, under the ledger lock. Returns true when the file on
   * disk no longer holds a bad row.
   *
   * ORDERED SO A CRASH CANNOT LOSE A ROW: the quarantine copy is written first,
   * so the worst interruption leaves the bad rows in two places rather than
   * none. One attempt per failure streak — it is reached from every key's first
   * touch, and a lock we could not take is not a reason to try again per
   * message.
   */
  private healLegacyStemLedgerRows(): boolean {
    if (this.legacyStemLedgerHealAttempted) return false;
    this.legacyStemLedgerHealAttempted = true;
    try {
      return withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-read the RAW file inside the lock: another process may have
        // repaired or replaced it while we waited.
        let data: Partial<LegacyStemLedgerFile>;
        try {
          data = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<LegacyStemLedgerFile>;
        } catch {
          return false;
        }
        const stems = data?.stems;
        if (!stems || typeof stems !== "object" || Array.isArray(stems)) return false;
        const good: Record<string, unknown> = {};
        const bad: Record<string, unknown> = {};
        for (const [stem, owners] of Object.entries(stems)) {
          if (Array.isArray(owners) && owners.every((key) => typeof key === "string")) good[stem] = owners;
          else bad[stem] = owners;
        }
        if (Object.keys(bad).length === 0) return true;
        const to = this.freeLegacyStemLedgerCorruptName();
        if (to === null) return false;
        // Verbatim: whatever was in the row is what a human gets to look at.
        writeJsonAtomicSync(to, { version: 1, stems: bad });
        writeJsonAtomicSync(this.path, { version: 1, stems: good });
        log.warn(
          { file: this.path, to, stems: Object.keys(bad) },
          "Moved unreadable rows out of the legacy transcript stem ledger into a `.corrupt-` sibling and kept the "
          + "readable ones; only the sessions named by those rows stay deferred, and the quarantined copy is the "
          + "only record of the owners they held",
        );
        return true;
      }, this.ledgerLockOptions);
    } catch (err) {
      log.warn(
        { err, file: this.path },
        "Could not move the unreadable rows out of the legacy transcript stem ledger; every session named by a bad "
        + "row stays deferred",
      );
      return false;
    }
  }

  /**
   * Quarantine a ledger whose JSON is unparseable as a whole, from the READ
   * path, and keep failing closed afterwards.
   *
   * The bytes are preserved (they may be the only record that some key owned a
   * stem) and nothing is rebuilt from `{}` — `remember` refuses
   * while `legacyStemLedgerUnparseable` is set, because a rebuild from `{}` here
   * would turn "I cannot read the owners" into "there are no owners" with the
   * evidence already moved aside. Within this process that means every migration
   * stays deferred until a readable ledger is back; the `.corrupt-` file and the
   * warning are what a human acts on.
   */
  private quarantineUnparseableLedger(): void {
    if (this.legacyStemLedgerUnparseable) return;
    try {
      withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-checked inside the lock: another process may have replaced the file
        // with a good one, and quarantining THAT would throw away real rows.
        try {
          const data = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<LegacyStemLedgerFile>;
          const stems = data?.stems;
          if (stems && typeof stems === "object" && !Array.isArray(stems)) return;
        } catch {
          // Still unparseable — go on.
        }
        if (!existsSync(this.path)) return;
        this.legacyStemLedgerUnparseable = true;
        this.quarantineLegacyStemLedger();
      }, this.ledgerLockOptions);
    } catch (err) {
      log.warn(
        { err, file: this.path },
        "Could not quarantine the unparseable legacy transcript stem ledger; migrations stay deferred",
      );
    }
  }

  /** A free `_legacy_stems.json.corrupt-<ts>[-<n>]`, or null when a hundred of
   *  them are taken. */
  private freeLegacyStemLedgerCorruptName(): string | null {
    const ts = fileTimestamp();
    for (let n = 0; n < 100; n++) {
      const to = n === 0
        ? `${this.path}.corrupt-${ts}`
        : `${this.path}.corrupt-${ts}-${n}`;
      if (!existsSync(to)) return to;
    }
    return null;
  }

  /**
   * Which stems the `.corrupt-` copies of the ledger still hold, read off the
   * DIRECTORY on every probe rather than off this process's memory.
   *
   * THIS IS WHAT MAKES THE QUARANTINE SURVIVE A RESTART. Row healing and
   * whole-file quarantine both leave a ledger that parses cleanly and a copy of
   * the unreadable part beside it; the "these stems' owners were unreadable"
   * fact lived only in the healing process's fields, so a SECOND process read
   * the healed ledger, saw no partner, answered `sole`, and adopted a file whose
   * other owner was named in nothing but the quarantined rows. Reading the
   * copies back closes that without a format change.
   *
   * CHEAP WHEN THERE IS NOTHING TO FIND, which is always, on every install that
   * has never had a bad row: one `readdir` and a prefix filter, no file opened.
   * When a copy does exist the parse is cached against a signature over the
   * copies' names, sizes and mtimes — so an operator who DELETES or REPAIRS one
   * releases the hold on the next message, which is the documented way out.
   */
  private corruptLegacyStemLedgerHold(): CorruptLedgerHold {
    const prefix = `${LEGACY_STEM_LEDGER_FILENAME}.corrupt-`;
    const files = this.dirNames().filter((name) => name.startsWith(prefix)).sort();
    if (files.length === 0) {
      this.legacyStemLedgerCorruptCache = null;
      return NO_CORRUPT_LEDGER_HOLD;
    }
    const signature = files.map((name) => {
      try {
        const st = statSync(join(this.dir, name));
        return `${name}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${name}:gone`;
      }
    }).join("|");
    const cached = this.legacyStemLedgerCorruptCache;
    if (cached !== null && cached.signature === signature) return cached.hold;

    const stems = new Map<string, string>();
    let unparseable: string | null = null;
    for (const name of files) {
      // ROW-WISE AND BEST EFFORT: a copy written by `healLegacyStemLedgerRows`
      // is valid JSON whose VALUES are the unreadable part, so its keys are
      // exactly the stems to hold. Anything we cannot get keys out of at all
      // falls through to `unparseable`.
      let rows: unknown;
      try {
        rows = (JSON.parse(readFileSync(join(this.dir, name), "utf-8")) as Partial<LegacyStemLedgerFile> | null)?.stems;
      } catch {
        unparseable ??= name;
        continue;
      }
      if (!rows || typeof rows !== "object" || Array.isArray(rows)) {
        unparseable ??= name;
        continue;
      }
      for (const [stem, owners] of Object.entries(rows as Record<string, unknown>)) {
        // A row that parses as a valid owner list has been REPAIRED in place
        // (the documented recovery): it no longer holds anything. Only rows
        // whose value is still unreadable name a stem to defer.
        if (Array.isArray(owners) && owners.every((owner) => typeof owner === "string" && owner.length > 0)) continue;
        const folded = stem.toLowerCase();
        if (!stems.has(folded)) stems.set(folded, name);
      }
    }
    const hold: CorruptLedgerHold = { stems, unparseable };
    this.legacyStemLedgerCorruptCache = { signature, hold };
    return hold;
  }

  /**
   * The `.corrupt-` copy that makes `target` (a case-folded legacy stem)
   * unknown, or null when none does.
   *
   * `stems` is the HEALED ledger's rows: a stem it still carries a row for has
   * readable owners on disk, so even a copy we cannot read row-wise cannot make
   * it ambiguous. Every other stem is held by such a copy, because "this copy
   * might name your partner" is the only honest reading of bytes nobody can
   * parse.
   */
  heldByCorrupt(target: string, stems: Record<string, string[]>): string | null {
    const hold = this.corruptLegacyStemLedgerHold();
    const named = hold.stems.get(target);
    if (named !== undefined) return named;
    if (hold.unparseable === null) return null;
    for (const stem of Object.keys(stems)) {
      if (stem.toLowerCase() === target) return null;
    }
    return hold.unparseable;
  }

  /** One line per failure streak: the ledger is read on every key's first
   *  touch, so a corrupt file must not write a line per message. */
  private noteLegacyStemLedgerUnreadable(err: unknown): void {
    if (this.legacyStemLedgerErrorLogged) return;
    this.legacyStemLedgerErrorLogged = true;
    log.warn(
      { err, file: this.path },
      "Could not load the legacy transcript stem ledger; the migrations that depend on what it says are deferred "
      + "until it reads again, and the part that could not be read is moved to a `.corrupt-<ts>` sibling from here "
      + "— a whole unparseable file, or just the rows that would not parse",
    );
  }

  /**
   * Move an unparseable ledger aside so a rewrite can start from `{}`.
   *
   * QUARANTINED, NEVER OVERWRITTEN IN PLACE. Whatever is in there may be the
   * only remaining record that some key owned a legacy stem, and the rewrite
   * below cannot preserve what it could not parse — so the bytes go to a name no
   * reader matches, and a failure to move them means nothing is written at all.
   */
  private quarantineLegacyStemLedger(): boolean {
    const to = this.freeLegacyStemLedgerCorruptName();
    if (to === null) return false;
    try {
      renameSync(this.path, to);
    } catch (err) {
      log.warn(
        { err, file: this.path },
        "Could not quarantine the unparseable legacy transcript stem ledger; nothing was recorded",
      );
      return false;
    }
    log.warn(
      { from: this.path, to },
      "The legacy transcript stem ledger could not be parsed and was quarantined. NOTHING is rebuilt from `{}` on "
      + "top of it — every transcript migration in this process stays deferred — and the quarantined copy is the "
      + "only record of any owner it still named",
    );
    return true;
  }

  /**
   * Record that `keys` have owned their legacy transcript stems, so a later
   * migration can still see them after the registry has forgotten them.
   *
   * Returns false when nothing could be persisted — the caller is about to
   * forget the key, so it should NOT: a lost record here is the silent
   * cross-session leak this ledger exists to prevent, and every caller's work
   * is bookkeeping that the next daemon start redoes for free.
   *
   * Only keys whose legacy stem is not already recorded cause a write, so the
   * steady state is a read of a small JSON file.
   */
  remember(keys: readonly string[]): boolean {
    const wanted = new Map<string, Set<string>>();
    for (const key of keys) {
      if (!key) continue;
      const stem = legacyTranscriptFileStem(key);
      let bucket = wanted.get(stem);
      if (!bucket) wanted.set(stem, bucket = new Set());
      bucket.add(key);
    }
    if (wanted.size === 0) return true;

    try {
      return withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-read inside the lock: another process may have recorded keys of
        // its own since we last looked, and this is a read-modify-write.
        let loaded = this.load();
        // NEVER REBUILD FROM `{}`. That is what discarded the ownership evidence
        // of every row that was readable, and the quarantined copy a human would
        // have to restore it from does not come back on its own. An unreadable
        // ledger means this write does not happen, and the caller keeps whatever
        // it was about to forget.
        if (!loaded.ok) return false;
        if (loaded.malformed.length > 0) {
          // Rewriting now would drop the bad rows silently — they are not in
          // `stems`. Carry them to the `.corrupt-` sibling first.
          if (!this.healLegacyStemLedgerRows()) return false;
          loaded = this.load();
          if (!loaded.ok || loaded.malformed.length > 0) return false;
        }
        const stems = loaded.stems;
        let changed = false;
        for (const [stem, owners] of wanted) {
          const existing = new Set(stems[stem] ?? []);
          const before = existing.size;
          for (const owner of owners) existing.add(owner);
          if (existing.size === before) continue;
          stems[stem] = [...existing].sort();
          changed = true;
        }
        if (changed) {
          writeJsonAtomicSync(this.path, { version: 1, stems } satisfies LegacyStemLedgerFile);
        }
        return true;
      }, this.ledgerLockOptions);
    } catch (err) {
      log.warn(
        { err, file: this.path, keys: [...keys] },
        "Could not record legacy transcript stem ownership; keeping the session entries for the next pass",
      );
      return false;
    }
  }

  /**
   * Drop every ledger row whose stem has nothing left on disk.
   *
   * A row exists to make a legacy-named file ambiguous. Once no file is named
   * after the stem — no `<stem>.jsonl`, no `_archive_<stem>_*`, no sidecar and
   * no quarantine — the row can never change an answer: `migrateLegacyTranscript`
   * returns "settled" on the absence of those files, before it ever looks at
   * the ledger. So pruning is safe, and it is what keeps the file from growing a
   * permanent row for every key the registry ever forgot.
   *
   * Returns the stems dropped. Best-effort, like every other ledger write.
   */
  prune(): string[] {
    let names: Set<string>;
    try {
      names = new Set(readdirSync(this.dir).map((n) => n.toLowerCase()));
    } catch {
      return [];
    }
    const before = this.load();
    if (!before.ok || before.malformed.length > 0) return [];
    const candidates = Object.keys(before.stems).filter((stem) => !stemHasFilesOnDisk(stem, names));
    if (candidates.length === 0) return [];

    try {
      return withFileLockSync(this.legacyStemLedgerLockPath, () => {
        // Re-read inside the lock for the same reason every other writer does,
        // and re-filter against it: another process may have added a row.
        const loaded = this.load();
        // An unreadable row would be dropped by the rewrite below, and pruning is
        // an optimization — it waits for the read path to carry the row aside.
        if (!loaded.ok || loaded.malformed.length > 0) return [];
        const stems = loaded.stems;
        const dropped = candidates.filter((stem) => stem in stems);
        if (dropped.length === 0) return [];
        for (const stem of dropped) delete stems[stem];
        writeJsonAtomicSync(this.path, { version: 1, stems } satisfies LegacyStemLedgerFile);
        log.debug({ stems: dropped }, "Pruned legacy transcript stem ledger rows with nothing left on disk");
        return dropped;
      }, this.ledgerLockOptions);
    } catch (err) {
      log.warn({ err, file: this.path }, "Could not prune the legacy transcript stem ledger");
      return [];
    }
  }

  /** Prune just the rows for one legacy stem, after its migration settled.
   *  Cheap enough to run on the settle path; the directory-wide sweep above is
   *  what catches rows written by a key that never had a legacy file. */
  pruneFor(legacy: string): void {
    let names: Set<string>;
    try {
      names = new Set(readdirSync(this.dir).map((n) => n.toLowerCase()));
    } catch {
      return;
    }
    if (stemHasFilesOnDisk(legacy, names)) return;
    const loaded = this.load();
    if (!loaded.ok) return;
    const folded = legacy.toLowerCase();
    if (!Object.keys(loaded.stems).some((stem) => stem.toLowerCase() === folded)) return;
    this.prune();
  }
}
