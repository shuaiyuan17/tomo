import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config, CONFIG_PATH } from "../config.js";
import { withConfigLockSync } from "../config-file.js";
import { CronStore } from "../cron/store.js";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import type { SessionStore } from "../sessions/index.js";
import { backupConfigFile } from "./commands.js";

/**
 * Adoption of a legacy per-channel owner session into the owner's `dm:` key,
 * together with its cron jobs and model override (see `Agent.prepareOwner`).
 */
export class OwnerAdoption {
  constructor(
    private readonly sessions: SessionStore,
    private readonly modelOverrides: Map<string, string>,
  ) {}

  /** Written before an adoption and removed once its cron jobs and model
   *  override have moved too; a leftover means "finish the follow-ups". */
  private get adoptionMarkerPath(): string {
    return join(config.tomoHome, "data", "owner-adoption-pending.json");
  }

  /**
   * The one-time adoption of a legacy per-channel session into the owner's
   * `dm:` key, WITH everything that is keyed by the session: its cron jobs
   * (`data/cron/jobs.json`) and its `sessionModelOverrides` entry. Moving only
   * the registry entry left the jobs on the raw key — the next run forked a
   * fresh session there — and dropped the owner's model.
   *
   * Order is what makes it safe to interrupt: a marker naming (from, to) is
   * written first, then the registry re-key (the step that can refuse, in
   * which case the marker is removed and the router retries later), then the
   * follow-ups, then the marker is removed. Both follow-ups are idempotent, and
   * `prepareOwner` finishes any marker left behind by a crash.
   */
  adoptLegacySession(from: string, to: string): void {
    const marker = this.adoptionMarkerPath;
    mkdirSync(join(config.tomoHome, "data"), { recursive: true });
    writeJsonAtomicSync(marker, { version: 1, from, to, at: Date.now() }, { mode: 0o600 });
    try {
      this.sessions.migrateSessionKey(from, to);
    } catch (err) {
      rmSync(marker, { force: true });
      throw err;
    }
    this.finishAdoption(from, to);
  }

  /** Move cron jobs and the model override from `from` to `to`; idempotent. */
  private finishAdoption(from: string, to: string): void {
    try {
      const moved = new CronStore(join(config.tomoHome, "data", "cron", "jobs.json")).rewriteSessionKey(from, to);
      if (moved > 0) log.info({ from, to, jobs: moved }, "Moved cron jobs with the adopted session");
      this.moveModelOverride(from, to);
      rmSync(this.adoptionMarkerPath, { force: true });
    } catch (err) {
      log.warn({ err, from, to }, "Adopted session's cron jobs / model override not moved yet; retrying on next start");
    }
  }

  private moveModelOverride(from: string, to: string): void {
    // Under the shared config lock, re-reading inside it: `tomo config` may be
    // saving at the same moment (see saveConfig's field-level merge).
    withConfigLockSync(CONFIG_PATH, () => {
      if (!existsSync(CONFIG_PATH)) return;
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      const overrides = (cfg.sessionModelOverrides ?? {}) as Record<string, string>;
      if (overrides[from] === undefined) return;
      if (overrides[to] === undefined) overrides[to] = overrides[from];
      delete overrides[from];
      cfg.sessionModelOverrides = overrides;
      backupConfigFile();
      writeJsonAtomicSync(CONFIG_PATH, cfg, { mode: 0o600 });
    });
    const live = config.sessionModelOverrides;
    if (live[from] !== undefined) {
      if (live[to] === undefined) live[to] = live[from];
      delete live[from];
      log.info({ from, to }, "Moved the model override with the adopted session");
    }
    const loaded = this.modelOverrides.get(from);
    if (loaded !== undefined) {
      if (!this.modelOverrides.has(to)) this.modelOverrides.set(to, loaded);
      this.modelOverrides.delete(from);
    }
  }

  /** Finish the follow-ups of an adoption a crash interrupted (daemon start). */
  finishInterruptedAdoption(): void {
    // An adoption interrupted after its re-key: finish moving its cron jobs
    // and model override (the re-key itself is in the registry already).
    if (existsSync(this.adoptionMarkerPath)) {
      try {
        const pending = JSON.parse(readFileSync(this.adoptionMarkerPath, "utf-8")) as { from?: unknown; to?: unknown };
        if (typeof pending.from === "string" && typeof pending.to === "string"
          && this.sessions.getEntry(pending.to)?.migratedFrom === pending.from) {
          this.finishAdoption(pending.from, pending.to);
        } else {
          rmSync(this.adoptionMarkerPath, { force: true });
        }
      } catch (err) {
        log.warn({ err }, "Unreadable owner adoption marker left in place");
      }
    }
  }
}
