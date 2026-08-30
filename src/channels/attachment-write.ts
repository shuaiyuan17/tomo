import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../logger.js";

/**
 * The one place inbound attachment bytes reach the disk.
 *
 * Every inbound path — images (imageStore.ts), documents (documentStore.ts)
 * and any-MIME files (fileStore.ts) — builds a *deterministic* destination
 * name out of a second-resolution timestamp, the session key and a short
 * discriminator. Deterministic means collidable: two attachments in one
 * message land in the same second, in the same chat, and can easily produce
 * the same discriminator (an 8-character prefix of a guid, or nothing at all
 * when the channel supplies no guid).
 *
 * A plain `writeFile` resolves that collision by destroying the first file,
 * and then returns its path — so the marker line handed to the agent reads
 * "[Sent 2 images, saved to: P, P]" while exactly one file exists. The bytes
 * the sender believes were delivered are gone, and nothing anywhere says so.
 *
 * `wx` moves the create-or-fail decision into the kernel, which is what makes
 * this correct rather than merely likely: a `existsSync` check followed by a
 * write is two syscalls with a window between them, and two attachments of the
 * same message are downloaded concurrently.
 *
 * This started life inside fileStore.ts (2026-08-27) and is hoisted here
 * unchanged in behaviour so the two older siblings get the same guarantee.
 */

/** How many `name-1`, `name-2`, … variants to try before giving up. */
export const MAX_COLLISION_ATTEMPTS = 50;

/** Split "a.tar.gz" into ["a.tar", ".gz"]; a leading-dot-free name is assumed. */
export function splitExt(filename: string): [string, string] {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return [filename, ""];
  return [filename.slice(0, dot), filename.slice(dot)];
}

/**
 * Create `dir` and write `buffer` into it under `filename`, never overwriting
 * an existing file: on collision the name becomes `stem-1.ext`, `stem-2.ext`,
 * … up to {@link MAX_COLLISION_ATTEMPTS}.
 *
 * @returns the absolute path actually written, or `null` if every candidate
 *          name was taken. Other filesystem errors propagate — the callers
 *          each have a `catch` that logs and degrades to "not saved".
 */
export async function writeWithoutOverwrite(
  dir: string,
  filename: string,
  buffer: Buffer,
): Promise<string | null> {
  await mkdir(dir, { recursive: true });
  const [stem, ext] = splitExt(filename);

  for (let attempt = 0; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
    const candidate = join(dir, attempt === 0 ? filename : `${stem}-${attempt}${ext}`);
    try {
      await writeFile(candidate, buffer, { flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Ordinary, not exceptional: phones name things IMG_0001 and a message
      // carries several at once. Debug, because the caller logs the path it
      // actually got at info and that is the line worth reading.
      log.debug({ candidate }, "Inbound attachment name already taken; trying the next one");
    }
  }

  return null;
}
