import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { withFileLockSync } from "../file-lock.js";
import { validAccessToken } from "./access.js";

/** Called only in the supervised web child: disk/lock failures cannot stall
 * the daemon. Never follow a token symlink or reuse a broadly readable file. */
export function loadWebToken(tomoHome: string, diagnostic: (message: string) => void): string {
  mkdirSync(tomoHome, { recursive: true, mode: 0o700 });
  const parent = lstatSync(tomoHome);
  if (!parent.isDirectory() || (parent.mode & 0o022) || parent.uid !== process.getuid?.()) throw new Error("Unsafe web token directory");
  const path = join(tomoHome, "web-token");
  return withFileLockSync(`${path}.lock`, () => {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.size <= 74 && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.uid === process.getuid?.()) {
        const token = readFileSync(fd, "utf8").trim();
        if (validAccessToken(token)) return token;
      }
    } catch { /* Missing or unsafe entries are atomically replaced below. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    const token = `tomo_web_${randomBytes(32).toString("hex")}`;
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, `${token}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
    diagnostic("Web access token created or replaced; use the new access link.");
    return token;
  }, { timeoutMs: 1_000 });
}

/** The normal daemon log is intentionally shareable. Keep usable access
 * links in this private file instead, and let normal log redaction scrub the
 * recognizable token prefix. This also protects tool-output log summaries. */
export function writeWebAccessLinks(tomoHome: string, links: string[]): void {
  const path = join(tomoHome, "web-access.log");
  withFileLockSync(`${path}.lock`, () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, links.join("\n") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
  }, { timeoutMs: 1_000 });
}
