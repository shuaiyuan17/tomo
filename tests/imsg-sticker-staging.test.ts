import { mkdirSync, mkdtempSync, chmodSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { isStickerStagingRefusal, stickerStagingDiagnosis } from "../src/channels/imsg-sticker-staging.js";

// Reproduces, daemon-side, the dylib's openUserOwnedDirectorySecurely checks
// (imsg 0.13.4, IMsgInjected.m): $HOME → Library/Messages/Attachments/imsg/
// stickers, each component a real user-owned directory, no symlinks, not
// world-writable. The diagnosis names the first offender and its remedy.

let home: string;

const makeHome = (...components: string[]): string => {
  home = mkdtempSync(join(tmpdir(), "tomo-staging-home-"));
  let current = home;
  for (const c of components) {
    current = join(current, c);
    mkdirSync(current, { mode: 0o755 });
  }
  return home;
};

afterEach(() => {
  if (home) {
    // Restore write bits so cleanup can recurse.
    rmSync(home, { recursive: true, force: true });
  }
});

describe("isStickerStagingRefusal", () => {
  it("matches the dylib's staging-hygiene error family", () => {
    expect(isStickerStagingRefusal(new Error(
      "imsg rpc send.sticker failed (-32603) Internal error: Dylib error: Could not securely open sticker directory",
    ))).toBe(true);
    expect(isStickerStagingRefusal(new Error("Dylib error: Could not securely open sticker image"))).toBe(true);
    expect(isStickerStagingRefusal(new Error("Sticker must use imsg's trusted staging directory"))).toBe(true);
  });

  it("does not match unrelated sticker refusals or non-errors", () => {
    expect(isStickerStagingRefusal(new Error("Sticker image must be between 1 byte and 512000 bytes"))).toBe(false);
    expect(isStickerStagingRefusal(new Error("chat is not an iMessage conversation"))).toBe(false);
    expect(isStickerStagingRefusal("Could not securely open sticker directory")).toBe(false);
  });
});

describe("stickerStagingDiagnosis", () => {
  it("passes a clean chain (absent imsg/stickers leaves are created on demand)", () => {
    const h = makeHome("Library", "Messages", "Attachments");
    const diag = stickerStagingDiagnosis(h);
    expect(diag.stagingRoot).toBe(join(h, "Library", "Messages", "Attachments", "imsg", "stickers"));
    expect(diag.verdict).toMatch(/passes the dylib's hygiene checks/);
    expect(diag.checked[join(h, "Library", "Messages")]).toMatch(/^mode=0755 uid=\d+$/);
    expect(diag.checked[join(h, "Library", "Messages", "Attachments", "imsg")]).toBe("absent");
  });

  it("names a world-writable ancestor and the chmod o-w remedy (the live 2026-08-06 failure)", () => {
    const h = makeHome("Library", "Messages", "Attachments", "imsg", "stickers");
    const messages = join(h, "Library", "Messages");
    chmodSync(messages, 0o777);
    const diag = stickerStagingDiagnosis(h);
    expect(diag.verdict).toContain(`${messages} is world-writable (mode 0777)`);
    expect(diag.verdict).toContain(`chmod o-w '${messages}'`);
    // The walk stops at the first offender, mirroring the dylib.
    expect(diag.checked[join(h, "Library", "Messages", "Attachments")]).toBeUndefined();
  });

  it("names a symlinked component (the dylib opens with O_NOFOLLOW)", () => {
    const h = makeHome("Library", "real-messages");
    symlinkSync(join(h, "Library", "real-messages"), join(h, "Library", "Messages"));
    const diag = stickerStagingDiagnosis(h);
    expect(diag.verdict).toContain(`${join(h, "Library", "Messages")} is a symbolic link`);
  });

  it("names a non-directory component", () => {
    const h = makeHome("Library");
    writeFileSync(join(h, "Library", "Messages"), "not a dir");
    const diag = stickerStagingDiagnosis(h);
    expect(diag.verdict).toContain(`${join(h, "Library", "Messages")} is not a directory`);
  });

  it("reports a missing required component (nothing to stage under)", () => {
    const h = makeHome("Library");
    const diag = stickerStagingDiagnosis(h);
    expect(diag.verdict).toContain(`${join(h, "Library", "Messages")} does not exist`);
  });

  it("never throws on a bogus home", () => {
    home = ""; // nothing for afterEach to clean
    const diag = stickerStagingDiagnosis("/nonexistent-home-for-tomo-tests");
    expect(diag.verdict).toContain("does not exist");
  });
});
