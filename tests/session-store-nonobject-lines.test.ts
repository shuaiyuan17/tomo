import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessions/store.js";
import { transcriptFileStem } from "../src/sessions/transcript-names.js";
import type { SessionMessage } from "../src/sessions/types.js";

/**
 * A transcript line that is valid JSON but not an object (`null`, a bare
 * number or string, an array) is corruption, the same as a torn line. The
 * readers used to hand it out as a record, and the first field read on it
 * (`.role`, `.seq`, `.timestamp`) threw: loading the session, searching it,
 * counting it, and the next `append` on the message path. Each layout below
 * puts the junk in a different file of the read set.
 */

const KEY = "telegram:1";
const STEM = transcriptFileStem(KEY);
const JUNK = ["null", "42", '"x"', "[]"];
const LEGACY_SIDECAR_TS = "20260101-000000";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tomo-test-nonobject-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function line(msg: SessionMessage): string {
  return JSON.stringify(msg);
}

function user(content: string, seq: number, timestamp: number): SessionMessage {
  return { role: "user", content, timestamp, seq };
}

const now = Date.now();
const jan = Date.UTC(2020, 0, 15);

/**
 * Write the layout's files. Returns the contents it expects back, oldest
 * first: `loaded` from the session (active file and sidecars, never
 * archives), `searched` from the whole history, and the seq the next append
 * gets (junk lines must not throw off the count).
 */
interface Expected { loaded: string[]; searched: string[]; nextSeq: number }
const layouts: Array<[string, () => Expected]> = [
  ["the active file", () => {
    writeFileSync(join(dir, `${STEM}.jsonl`),
      [JUNK[0], line(user("one", 1, now - 2000)), ...JUNK.slice(1), line(user("two", 2, now - 1000)), "null"].join("\n") + "\n");
    return { loaded: ["one", "two"], searched: ["one", "two"], nextSeq: 3 };
  }],
  ["an archive", () => {
    writeFileSync(join(dir, `_archive_${STEM}_2020-01.jsonl`),
      [...JUNK, line(user("archived", 1, jan)), ...JUNK].join("\n") + "\n");
    writeFileSync(join(dir, `${STEM}.jsonl`), line(user("live", 2, now - 1000)) + "\n");
    return { loaded: ["live"], searched: ["archived", "live"], nextSeq: 3 };
  }],
  ["a legacy sidecar", () => {
    // A sidecar switches search to the unordered (timestamp-sorted) path.
    writeFileSync(join(dir, `${STEM}.legacy-${LEGACY_SIDECAR_TS}.jsonl`),
      [...JUNK, line(user("legacy", 7, now - 5000))].join("\n") + "\n");
    writeFileSync(join(dir, `${STEM}.jsonl`), [line(user("live", 1, now - 1000)), "null"].join("\n") + "\n");
    return { loaded: ["legacy", "live"], searched: ["legacy", "live"], nextSeq: 2 };   // a sidecar's seq is a separate run
  }],
];

describe("SessionStore with non-object transcript lines", () => {
  it.each(layouts)("loads, searches, counts and appends with junk in %s", (_name, write) => {
    const { loaded, searched, nextSeq } = write();
    const store = new SessionStore(dir, 20, join(dir, "sdk-sessions"));

    expect(store.get(KEY).messages.map((m) => m.content)).toEqual(loaded);
    expect(store.searchTranscript(KEY, { limit: 50 }).map((m) => m.content)).toEqual(searched);
    expect(store.searchTranscript(KEY, { query: searched[0], limit: 50 }).map((m) => m.content)).toEqual([searched[0]]);
    expect(store.countRecentUserMessages(KEY)).toBe(loaded.length);

    // A fresh store has no cached seq, so this append reads the tail itself.
    const fresh = new SessionStore(dir, 20, join(dir, "sdk-sessions"));
    fresh.append(KEY, { role: "user", content: "after", timestamp: now });
    const written = readFileSync(join(dir, `${STEM}.jsonl`), "utf-8").trimEnd().split("\n");
    const appended = JSON.parse(written[written.length - 1]) as SessionMessage;
    expect(appended.content).toBe("after");
    expect(appended.seq).toBe(nextSeq);
  });
});
