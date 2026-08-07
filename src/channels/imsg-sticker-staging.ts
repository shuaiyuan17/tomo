import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Legible failure mode for imsg's sticker staging-hygiene refusal.
 *
 * What actually happens on a sticker send (verified against imsg v0.13.4
 * source — Sources/IMsgCore/StickerAsset.swift, RPCServer+StickerHandlers.swift,
 * IMsgHelper/IMsgInjected.m):
 *
 * 1. BOTH the `imsg send-sticker` CLI and the `send.sticker` RPC handler run
 *    the same `StickerAssetPreparer.prepare` step: validate the image
 *    (PNG/GIF/JPEG, ≤500KB, ≤618×618, ≤100 frames), then copy the bytes into
 *    `~/Library/Messages/Attachments/imsg/stickers/<uuid>/<sha16>.<ext>`
 *    (directory 0700, file 0600) and pass THAT staged path to the bridge.
 *    A caller sending `send.sticker` over RPC therefore does NOT need to
 *    stage anything itself, and the staged copy is discarded by imsg after
 *    the bridge call — no cleanup falls on us.
 *
 * 2. The dylib inside Messages re-opens the staged file with a hardened walk
 *    (`openUserOwnedDirectorySecurely`): starting at `$HOME`, every path
 *    component down to the staged file's directory must be a real directory
 *    reached without following symlinks (O_NOFOLLOW), owned by the current
 *    user, and NOT world-writable. Any violation yields the opaque
 *    "Could not securely open sticker directory" / "…sticker image" errors,
 *    and a path outside the root yields "Sticker must use imsg's trusted
 *    staging directory".
 *
 * This module reproduces the dylib's checks from the daemon side so the log
 * can name the offending component and the exact remedy, instead of leaving
 * an opaque bridge error. (Observed live 2026-08-06: `~/Library/Messages`
 * chmod'd 0777 — world-writable — which fails the S_IWOTH check.)
 *
 * IMPORTANT CAVEAT (learned the hard way, same day): a clean walk here does
 * NOT mean the send will work. The dylib runs inside Messages.app's sandbox
 * and begins its secure walk by opening the user's HOME directory — a path
 * the sandbox denies (its exceptions cover only ~/Library/Messages). That
 * first open fails regardless of permissions, so on current imsg (≤0.13.4)
 * the sticker path is refused unconditionally while the rich-link path —
 * which starts its walk at the trusted root — works. Tracked upstream as
 * openclaw/imsg#211; until it lands, the all-clear verdict below points
 * there rather than at the user's filesystem.
 */

/**
 * The dylib's staging-hygiene error strings (IMsgInjected.m). A `send.sticker`
 * refusal matching one of these is a staging problem, not an image problem.
 */
const STAGING_ERROR_RE = /Sticker must use imsg's trusted staging directory|Could not securely open sticker (?:directory|image)/i;

/** True when an error is imsg's sticker staging-hygiene refusal. */
export function isStickerStagingRefusal(err: unknown): boolean {
  return err instanceof Error && STAGING_ERROR_RE.test(err.message);
}

export interface StickerStagingDiagnosis {
  /** imsg's trusted staging root for stickers. */
  stagingRoot: string;
  /** Per-component observation, in walk order from $HOME down. */
  checked: Record<string, string>;
  /** One-line conclusion naming the broken component and its remedy. */
  verdict: string;
}

/**
 * Walk `$HOME` → `Library/Messages/Attachments/imsg/stickers` applying the
 * same tests the dylib applies, and name the first component that fails.
 * Pure inspection — never modifies anything, never throws. `home` is
 * injectable for tests only.
 *
 * The uid check uses this process's uid; tomo and Messages.app run as the
 * same login user, so a mismatch seen here is a mismatch the dylib sees too.
 */
export function stickerStagingDiagnosis(home: string = homedir()): StickerStagingDiagnosis {
  const components = ["Library", "Messages", "Attachments", "imsg", "stickers"];
  const stagingRoot = join(home, ...components);
  const checked: Record<string, string> = {};
  const uid = typeof process.getuid === "function" ? process.getuid() : null;

  let current = home;
  // $HOME itself is the walk's anchor and is checked first by the dylib.
  const paths = [home, ...components.map((_, i) => join(home, ...components.slice(0, i + 1)))];
  for (const p of paths) {
    current = p;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      // `imsg`/`stickers` are created (0755-default / 0700) during staging;
      // absent is a normal pre-first-send state, not a refusal cause.
      const createdOnDemand = p === join(home, "Library", "Messages", "Attachments", "imsg")
        || p === stagingRoot;
      checked[p] = "absent";
      if (createdOnDemand) continue;
      return {
        stagingRoot,
        checked,
        verdict: `${p} does not exist — the imsg staging path cannot be created under it`,
      };
    }
    const mode = (st.mode & 0o7777).toString(8).padStart(4, "0");
    checked[p] = `mode=${mode} uid=${st.uid}${st.isSymbolicLink() ? " symlink" : ""}`;
    if (st.isSymbolicLink()) {
      return {
        stagingRoot,
        checked,
        verdict: `${p} is a symbolic link: the imsg bridge opens the staging path with O_NOFOLLOW and refuses `
          + "any symlinked component; the sticker staging chain must be plain directories",
      };
    }
    if (!st.isDirectory()) {
      return {
        stagingRoot,
        checked,
        verdict: `${p} is not a directory; the imsg bridge requires a plain directory chain to the staging root`,
      };
    }
    if (uid !== null && st.uid !== uid) {
      return {
        stagingRoot,
        checked,
        verdict: `${p} is owned by uid ${st.uid}, not the current user (${uid}): the imsg bridge requires every `
          + `component to be user-owned; fix with \`chown ${uid} '${p}'\``,
      };
    }
    if ((st.mode & 0o002) !== 0) {
      return {
        stagingRoot,
        checked,
        verdict: `${p} is world-writable (mode ${mode}): the imsg bridge's staging-hygiene walk refuses any `
          + `world-writable ancestor; fix with \`chmod o-w '${p}'\` and retry the sticker send`,
      };
    }
  }

  return {
    stagingRoot,
    checked,
    verdict: "every ancestor of the staging root passes the dylib's hygiene checks from this process's view. "
      + "The refusal is then almost certainly openclaw/imsg#211: the dylib's secure walk starts by opening the "
      + "user's HOME directory, which Messages.app's sandbox denies (its file exceptions cover only "
      + "~/Library/Messages), so the walk fails before any per-component check runs. Nothing user-side fixes "
      + "this — no chmod, no relaunch; it needs the upstream fix (start the walk at the trusted root, as the "
      + `rich-link path already does). Path checked: ${current}`,
  };
}
