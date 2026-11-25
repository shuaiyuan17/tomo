import { afterAll, describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  annotateSenderName,
  autoBindHandle,
  createPeopleSnapshot,
  findPersonByDisplayName,
  findPersonByHandle,
  findPersonByName,
  loadPeople,
  normalizeHandle,
  parsePersonFile,
  personTimeZone,
  renderParticipantLabels,
  renderPeopleRoster,
  resolveSenderTimeZone,
  serializePersonRecord,
  upsertPerson,
  type PeopleDirs,
  type PersonRecord,
} from "../src/people.js";
import { normalizeImessageHandle } from "../src/sessions/keys.js";
import { log } from "../src/logger.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tomo-test-people-"));
// The root is unique to this run, so nothing else will clean it up.
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
const dirs: PeopleDirs = {
  publicDir: join(TEST_DIR, "people"),
  privateDir: join(TEST_DIR, "private", "people"),
};

function writePerson(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf-8");
}

const KEVIN = `---
name: Kevin Wang
aliases: kw, KDub
telegram: 12345678
imessage: +1 (415) 555-1234
---

Met at Stanford. Runs the climbing group chat.
`;

describe("people store", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("parses frontmatter, handles, and notes", () => {
    const record = parsePersonFile(KEVIN, "/tmp/kevin.md", false);
    expect(record?.name).toBe("Kevin Wang");
    expect(record?.aliases).toEqual(["kw", "KDub"]);
    expect(record?.handles).toEqual({ telegram: "12345678", imessage: "+1 (415) 555-1234" });
    expect(record?.notes).toContain("Met at Stanford");
  });

  it("tolerates inline-array aliases, quotes, and full-width commas", () => {
    const record = parsePersonFile(
      `---\nname: "Alice Chen"\naliases: [Lissy\u3001'ali']\n---\n`, // U+3001: the ideographic comma
      "/tmp/a.md",
      false,
    );
    expect(record?.name).toBe("Alice Chen");
    expect(record?.aliases).toEqual(["Lissy", "ali"]);
  });

  it("preserves unknown frontmatter keys across a round trip", () => {
    const record = parsePersonFile(
      `---\nname: Bob\nbirthday: 1990-04-01\n---\nnotes\n`,
      "/tmp/b.md",
      false,
    )!;
    const reparsed = parsePersonFile(serializePersonRecord(record), "/tmp/b.md", false)!;
    expect(reparsed.extra).toEqual({ birthday: "1990-04-01" });
    expect(reparsed.notes).toBe("notes");
  });

  it("skips files without usable frontmatter", () => {
    expect(parsePersonFile("just some notes", "/tmp/x.md", false)).toBeUndefined();
    expect(parsePersonFile("---\naliases: x\n---\n", "/tmp/x.md", false)).toBeUndefined();
  });

  it("loads public and private records with scoping", () => {
    writePerson(dirs.publicDir, "kevin.md", KEVIN);
    writePerson(dirs.privateDir, "secret.md", `---\nname: Secret Friend\n---\n`);

    const groupScope = loadPeople({ includePrivate: false, dirs });
    expect(groupScope.map((p) => p.name)).toEqual(["Kevin Wang"]);

    const dmScope = loadPeople({ includePrivate: true, dirs });
    expect(dmScope.map((p) => p.name).sort()).toEqual(["Kevin Wang", "Secret Friend"]);
    expect(dmScope.find((p) => p.name === "Secret Friend")?.isPrivate).toBe(true);
  });

  it("matches handles with normalization (phone formatting, email case)", () => {
    writePerson(dirs.publicDir, "kevin.md", KEVIN);
    const people = loadPeople({ includePrivate: false, dirs });
    expect(findPersonByHandle(people, "imessage", "+14155551234")?.name).toBe("Kevin Wang");
    expect(findPersonByHandle(people, "telegram", "12345678")?.name).toBe("Kevin Wang");
    expect(findPersonByHandle(people, "telegram", "999")).toBeUndefined();
    expect(normalizeHandle("imessage", "Foo@Bar.COM")).toBe("foo@bar.com");
  });

  it("matches names and aliases case- and space-insensitively", () => {
    writePerson(dirs.publicDir, "kevin.md", KEVIN);
    const people = loadPeople({ includePrivate: false, dirs });
    expect(findPersonByName(people, "kevin  wang")?.name).toBe("Kevin Wang");
    expect(findPersonByName(people, "KW")?.name).toBe("Kevin Wang");
    expect(findPersonByName(people, "kdub")?.name).toBe("Kevin Wang");
    expect(findPersonByName(people, "kevin")).toBeUndefined();
  });

  it("returns no match when a name is ambiguous", () => {
    writePerson(dirs.publicDir, "a1.md", `---\nname: Alice Smith\naliases: alice\n---\n`);
    writePerson(dirs.publicDir, "a2.md", `---\nname: Alice Jones\naliases: alice\n---\n`);
    const people = loadPeople({ includePrivate: false, dirs });
    expect(findPersonByName(people, "alice")).toBeUndefined();
  });

  describe("findPersonByDisplayName (decoration-tolerant fallback)", () => {
    it("matches decorated wire names against plain aliases", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByDisplayName(people, "kw 🚀")?.name).toBe("Kevin Wang");
      expect(findPersonByDisplayName(people, "Lissy✨")).toBeUndefined();
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Chen\naliases: Lissy\n---\n`);
      const reloaded = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByDisplayName(reloaded, "Lissy✨")?.name).toBe("Alice Chen");
    });

    it("prefers an exact match over the stripped fallback", () => {
      writePerson(dirs.publicDir, "a.md", `---\nname: Rocket Kw\naliases: "kw 🚀"\n---\n`);
      writePerson(dirs.publicDir, "b.md", `---\nname: Kevin Wang\naliases: kw\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      // Exact alias "kw 🚀" wins even though stripped matching would be ambiguous.
      expect(findPersonByDisplayName(people, "kw 🚀")?.name).toBe("Rocket Kw");
    });

    it("does not fall through to stripped matching when the exact stage is ambiguous", () => {
      writePerson(dirs.publicDir, "a1.md", `---\nname: Alice Smith\naliases: alice\n---\n`);
      writePerson(dirs.publicDir, "a2.md", `---\nname: Alice Jones\naliases: alice\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByDisplayName(people, "alice")).toBeUndefined();
    });

    it("requires a unique stripped match and a non-trivial stripped form", () => {
      writePerson(dirs.publicDir, "a.md", `---\nname: Kevin Wang\naliases: kw\n---\n`);
      writePerson(dirs.publicDir, "b.md", `---\nname: Kelly West\naliases: "KW!"\n---\n`);
      writePerson(dirs.publicDir, "c.md", `---\nname: Kay\naliases: k\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByDisplayName(people, "kw 🚀")).toBeUndefined(); // two stripped "kw" candidates
      expect(findPersonByDisplayName(people, "k ⭐")).toBeUndefined(); // stripped form too short
    });
  });

  describe("upsertPerson", () => {
    it("creates a new record with a slug filename", () => {
      const { record, created } = upsertPerson(
        { name: "Kevin Wang", aliases: ["kw"], telegram: "123" },
        { includePrivate: true, dirs },
      );
      expect(created).toBe(true);
      expect(record.filePath).toBe(join(dirs.publicDir, "kevin-wang.md"));
      expect(readFileSync(record.filePath, "utf-8")).toContain("aliases: kw");
    });

    it("updates by alias, merges aliases, and keeps notes unless replaced", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const { record, created } = upsertPerson(
        { name: "Kevin Wang", match: "kw", aliases: ["Kev", "kw"] },
        { includePrivate: true, dirs },
      );
      expect(created).toBe(false);
      expect(record.aliases).toEqual(["kw", "KDub", "Kev"]);
      expect(record.notes).toContain("Met at Stanford");
    });

    it("keeps the old canonical name as an alias on rename", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const { record } = upsertPerson(
        { name: "Kevin W.", match: "KDub", aliases: [] },
        { includePrivate: true, dirs },
      );
      expect(record.name).toBe("Kevin W.");
      expect(record.aliases).toContain("Kevin Wang");
    });

    it("throws on ambiguous match", () => {
      writePerson(dirs.publicDir, "a1.md", `---\nname: Alice Smith\naliases: alice\n---\n`);
      writePerson(dirs.publicDir, "a2.md", `---\nname: Alice Jones\naliases: alice\n---\n`);
      expect(() =>
        upsertPerson({ name: "alice" }, { includePrivate: true, dirs }),
      ).toThrow(/matches 2 people/);
    });

    it("moves a record between public and private subtrees", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const { record } = upsertPerson(
        { name: "Kevin Wang", isPrivate: true },
        { includePrivate: true, dirs },
      );
      expect(record.isPrivate).toBe(true);
      expect(record.filePath.startsWith(dirs.privateDir)).toBe(true);
      expect(existsSync(join(dirs.publicDir, "kevin.md"))).toBe(false);
    });

    it("clears a handle when given an empty string", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const { record } = upsertPerson(
        { name: "Kevin Wang", telegram: "" },
        { includePrivate: true, dirs },
      );
      expect(record.handles.telegram).toBeUndefined();
      expect(record.handles.imessage).toBeTruthy();
    });
  });

  describe("autoBindHandle", () => {
    it("binds when the display name unambiguously matches an unbound record", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Chen\naliases: Lissy\n---\n`);
      const bound = autoBindHandle("telegram", "42", "Lissy", dirs);
      expect(bound?.name).toBe("Alice Chen");
      const reloaded = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByHandle(reloaded, "telegram", "42")?.name).toBe("Alice Chen");
    });

    it("does not steal a handle already bound to someone else's channel entry", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Chen\ntelegram: 7\n---\n`);
      expect(autoBindHandle("telegram", "42", "Alice Chen", dirs)).toBeUndefined();
      const reloaded = loadPeople({ includePrivate: false, dirs });
      expect(reloaded[0].handles.telegram).toBe("7");
    });

    it("skips ambiguous names and already-bound ids", () => {
      writePerson(dirs.publicDir, "a1.md", `---\nname: Alice Smith\naliases: alice\n---\n`);
      writePerson(dirs.publicDir, "a2.md", `---\nname: Alice Jones\naliases: alice\n---\n`);
      expect(autoBindHandle("telegram", "42", "alice", dirs)).toBeUndefined();

      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      expect(autoBindHandle("telegram", "12345678", "Someone Else", dirs)).toBeUndefined();
    });

    it("binds decorated display names via the stripped fallback", () => {
      writePerson(dirs.publicDir, "kevin.md", `---\nname: Kevin Wang\naliases: kw\n---\n`);
      const bound = autoBindHandle("telegram", "99", "kw 🚀", dirs);
      expect(bound?.name).toBe("Kevin Wang");
      const reloaded = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByHandle(reloaded, "telegram", "99")?.name).toBe("Kevin Wang");
    });

    it("never binds a private record from group traffic, even on a name collision", () => {
      writePerson(dirs.privateDir, "secret.md", `---\nname: Secret Friend\naliases: sf\n---\n`);
      expect(autoBindHandle("telegram", "42", "Secret Friend", dirs)).toBeUndefined();
      expect(autoBindHandle("telegram", "42", "sf 🚀", dirs)).toBeUndefined();
      const [secret] = loadPeople({ includePrivate: true, dirs });
      expect(secret.handles).toEqual({});
    });

    it("does not double-bind an id already owned by a private record onto a same-named public one", () => {
      writePerson(dirs.privateDir, "secret.md", `---\nname: Secret Friend\ntelegram: 42\n---\n`);
      writePerson(dirs.publicDir, "impostor.md", `---\nname: Secret Friend\n---\n`);
      expect(autoBindHandle("telegram", "42", "Secret Friend", dirs)).toBeUndefined();
      const publicOnly = loadPeople({ includePrivate: false, dirs });
      expect(publicOnly[0].handles).toEqual({});
    });
  });

  describe("prompt rendering", () => {
    it("renders resolved participant labels with aliases and wire names", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const people = loadPeople({ includePrivate: false, dirs });
      const labels = renderParticipantLabels({
        channelName: "telegram",
        participants: ["kw 🚀", "Unknown Guy"],
        participantIds: { "12345678": ["kw 🚀"] },
        people,
      });
      expect(labels).toEqual([
        'Kevin Wang (aka: kw, KDub; appears as "kw 🚀")',
        "Unknown Guy",
      ]);
    });

    it("joins a renamed profile to one participant entry via the sender id", () => {
      const labels = renderParticipantLabels({
        channelName: "telegram",
        participants: ["Old Name", "New Name"],
        participantIds: { "9": ["Old Name", "New Name"] },
        people: [],
      });
      expect(labels).toEqual(["New Name (also seen as: Old Name)"]);
    });

    it("does not list the same person twice across id and name matches", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const people = loadPeople({ includePrivate: false, dirs });
      const labels = renderParticipantLabels({
        channelName: "telegram",
        participants: ["kw", "Kevin Wang"],
        participantIds: { "12345678": ["kw"] },
        people,
      });
      expect(labels).toHaveLength(1);
      expect(labels[0]).toContain("Kevin Wang");
    });

    it("annotates sender names with the canonical name when they differ", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(annotateSenderName(people, "telegram", "kw 🚀", "12345678")).toBe("kw 🚀 (Kevin Wang)");
      expect(annotateSenderName(people, "telegram", "KDub")).toBe("KDub (Kevin Wang)");
      expect(annotateSenderName(people, "telegram", "Kevin Wang", "12345678")).toBe("Kevin Wang");
      expect(annotateSenderName(people, "telegram", "Stranger", "555")).toBe("Stranger");
    });

    it("annotates decorated names before any handle is bound", () => {
      writePerson(dirs.publicDir, "kevin.md", `---\nname: Kevin Wang\naliases: kw\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(annotateSenderName(people, "telegram", "kw 🚀", "999")).toBe("kw 🚀 (Kevin Wang)");
    });

    it("resolves decorated participant names without a sender id", () => {
      writePerson(dirs.publicDir, "kevin.md", `---\nname: Kevin Wang\naliases: kw\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      const labels = renderParticipantLabels({
        channelName: "telegram",
        participants: ["kw ✨"],
        people,
      });
      expect(labels).toEqual(['Kevin Wang (aka: kw; appears as "kw ✨")']);
    });

    it("renders the roster with aliases only", () => {
      const people: PersonRecord[] = [
        { name: "Kevin Wang", aliases: ["kw"], handles: { telegram: "1" }, extra: {}, notes: "secret", filePath: "/x", isPrivate: false },
        { name: "Bob", aliases: [], handles: {}, extra: {}, notes: "", filePath: "/y", isPrivate: false },
      ];
      const roster = renderPeopleRoster(people);
      expect(roster).toEqual(["- Kevin Wang — aka: kw", "- Bob"]);
      expect(roster.join("\n")).not.toContain("secret");
      expect(roster.join("\n")).not.toContain("telegram");
    });
  });

  // -------------------------------------------------------------------------
  // The request-scoped snapshot: one read shared by every consumer handling
  // one inbound message, with the narrower scope derived rather than re-read.
  // -------------------------------------------------------------------------
  describe("createPeopleSnapshot", () => {
    it("reads nothing until it is asked for records", () => {
      // The public directory does not even exist yet; creating a snapshot must
      // not care, because a message with no lookup to make should cost nothing.
      const snapshot = createPeopleSnapshot({
        publicDir: join(TEST_DIR, "never-created"),
        privateDir: join(TEST_DIR, "never-created-private"),
      });
      expect(snapshot).toBeDefined();
      expect(snapshot.scoped(false)).toEqual([]);
    });

    it("returns the same records loadPeople would, per scope", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Example\ntelegram: 7001\n---\n`);
      writePerson(dirs.privateDir, "carol.md", `---\nname: Carol Example\ntelegram: 7002\n---\n`);
      const snapshot = createPeopleSnapshot(dirs);

      expect(snapshot.scoped(false).map((p) => p.name)).toEqual(
        loadPeople({ includePrivate: false, dirs }).map((p) => p.name),
      );
      expect(snapshot.scoped(true).map((p) => p.name).sort()).toEqual(
        loadPeople({ includePrivate: true, dirs }).map((p) => p.name).sort(),
      );
      // The narrow scope is a filter of the wide one, not a second read, and
      // it must still exclude private records.
      expect(snapshot.scoped(false).map((p) => p.name)).toEqual(["Alice Example"]);
    });

    it("serves later calls from the first read", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Example\n---\n`);
      const snapshot = createPeopleSnapshot(dirs);
      expect(snapshot.scoped(false).map((p) => p.name)).toEqual(["Alice Example"]);

      // A write landing after the snapshot was taken is deliberately NOT
      // visible to it: the snapshot's life is one message, and the next
      // message takes a fresh one. This is what keeps it a scope, not a cache
      // with invalidation to get wrong.
      writePerson(dirs.publicDir, "bob.md", `---\nname: Bob Example\n---\n`);
      expect(snapshot.scoped(false).map((p) => p.name)).toEqual(["Alice Example"]);
      expect(createPeopleSnapshot(dirs).scoped(false).map((p) => p.name)).toEqual([
        "Alice Example", "Bob Example",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Optional `timezone` frontmatter. Everything the system prompt shows is the
  // STATIC identifier — no clock reading, no numeric offset — because that
  // block is prompt-cached; the live reading rides the message envelope
  // instead (tests/inbound-markers.test.ts).
  // -------------------------------------------------------------------------
  describe("timezone", () => {
    it("parses the timezone and round-trips it with every other field", () => {
      const source = `---\nname: Alice Example\naliases: ali\ntelegram: 1000\nimessage: +15550000000\ntimezone: Asia/Tokyo\nbirthday: 1990-04-01\n---\n\nSome notes.\n`;
      const record = parsePersonFile(source, "/tmp/alice.md", false)!;
      expect(record.timezone).toBe("Asia/Tokyo");

      const reparsed = parsePersonFile(serializePersonRecord(record), "/tmp/alice.md", false)!;
      expect(reparsed.timezone).toBe("Asia/Tokyo");
      expect(reparsed.aliases).toEqual(["ali"]);
      expect(reparsed.handles).toEqual({ telegram: "1000", imessage: "+15550000000" });
      expect(reparsed.extra).toEqual({ birthday: "1990-04-01" });
      expect(reparsed.notes).toBe("Some notes.");
    });

    it("keeps a record with an unusable timezone loadable", () => {
      const record = parsePersonFile(`---\nname: Bob Example\naliases: bobby\ntimezone: Not/AZone\n---\n`, "/tmp/b.md", false)!;
      expect(record.name).toBe("Bob Example");
      expect(record.aliases).toEqual(["bobby"]);
      // Held verbatim on the record, dropped at every point of use.
      expect(record.timezone).toBe("Not/AZone");
      expect(personTimeZone(record)).toBeUndefined();
    });

    it("writes, canonicalizes, and clears the timezone through upsertPerson", () => {
      const { record } = upsertPerson(
        { name: "Alice Example", timezone: "asia/tokyo" },
        { includePrivate: true, dirs },
      );
      expect(record.timezone).toBe("Asia/Tokyo");
      expect(readFileSync(record.filePath, "utf-8")).toContain("timezone: Asia/Tokyo");

      const cleared = upsertPerson(
        { name: "Alice Example", timezone: "" },
        { includePrivate: true, dirs },
      ).record;
      expect(cleared.timezone).toBeUndefined();
      expect(readFileSync(cleared.filePath, "utf-8")).not.toContain("timezone:");
    });

    it("refuses anything that is not a region identifier instead of storing it", () => {
      // "+09:00" is accepted by Intl and behaves like a stored offset — the
      // failure the feature exists to avoid. One value is enough here: it
      // proves the store routes through canonicalTimeZone, whose rejection
      // table (Etc/, legacy aliases, offsets) lives in timezone.test.ts.
      expect(
        () => upsertPerson({ name: "Alice Example", timezone: "+09:00" }, { includePrivate: true, dirs }),
      ).toThrow(/not a valid IANA time zone/);
    });

    it("leaves the rest of the record untouched when the timezone is rejected", () => {
      upsertPerson({ name: "Alice Example", aliases: ["ali"], notes: "keep me" }, { includePrivate: true, dirs });
      expect(() => upsertPerson(
        { name: "Alice Example", aliases: ["second"], timezone: "Not/AZone" },
        { includePrivate: true, dirs },
      )).toThrow();
      const [reloaded] = loadPeople({ includePrivate: true, dirs });
      expect(reloaded.aliases).toEqual(["ali"]);
      expect(reloaded.notes).toBe("keep me");
    });

    it("shows the identifier — never a clock or an offset — in participant labels", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Example\naliases: ali\ntelegram: 1000\ntimezone: Asia/Tokyo\n---\n`);
      writePerson(dirs.publicDir, "bob.md", `---\nname: Bob Example\ntelegram: 2000\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      const labels = renderParticipantLabels({
        channelName: "telegram",
        participants: [],
        participantIds: { "1000": ["Alice Example"], "2000": ["Bob Example"] },
        people,
      });
      expect(labels).toEqual(["Alice Example (aka: ali; Asia/Tokyo)", "Bob Example"]);
      expect(labels.join(" ")).not.toMatch(/\d{2}:\d{2}/);
    });

    it("omits an unusable timezone from labels and the roster, keeping the person", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Example\ntimezone: Not/AZone\n---\n`);
      writePerson(dirs.publicDir, "bob.md", `---\nname: Bob Example\ntimezone: Europe/Berlin\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(renderParticipantLabels({
        channelName: "telegram",
        participants: ["Alice Example", "Bob Example"],
        people,
      })).toEqual(["Alice Example", "Bob Example (Europe/Berlin)"]);
      expect(renderPeopleRoster(people)).toEqual([
        "- Alice Example",
        "- Bob Example — tz: Europe/Berlin",
      ]);
    });

    it("resolves a sender's timezone by handle and by alias", () => {
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Example\naliases: ali\ntelegram: 1000\ntimezone: Asia/Tokyo\n---\n`);
      writePerson(dirs.publicDir, "bob.md", `---\nname: Bob Example\ntelegram: 2000\n---\n`);
      const people = loadPeople({ includePrivate: false, dirs });
      expect(resolveSenderTimeZone(people, "telegram", "whatever they renamed to", "1000")).toBe("Asia/Tokyo");
      expect(resolveSenderTimeZone(people, "telegram", "ali")).toBe("Asia/Tokyo");
      // Resolves to a record with no timezone, and to no record at all.
      expect(resolveSenderTimeZone(people, "telegram", "Bob Example", "2000")).toBeUndefined();
      expect(resolveSenderTimeZone(people, "telegram", "Stranger", "9999")).toBeUndefined();
    });

    it("never lets a private record's timezone reach a public-scope lookup", () => {
      writePerson(dirs.privateDir, "private.md", `---\nname: Carol Example\naliases: carol\ntelegram: 3000\ntimezone: Asia/Tokyo\n---\n`);
      const groupScope = loadPeople({ includePrivate: false, dirs });
      expect(resolveSenderTimeZone(groupScope, "telegram", "Carol Example", "3000")).toBeUndefined();
      expect(renderParticipantLabels({
        channelName: "telegram",
        participants: ["Carol Example"],
        participantIds: { "3000": ["Carol Example"] },
        people: groupScope,
      })).toEqual(["Carol Example"]);

      // Same registry, DM scope: the record is there, timezone and all.
      const dmScope = loadPeople({ includePrivate: true, dirs });
      expect(resolveSenderTimeZone(dmScope, "telegram", "Carol Example", "3000")).toBe("Asia/Tokyo");
    });
  });
});

describe("iMessage handles: one normal form shared with sessions/keys", () => {
  // What the imsg channel hands people.ts as senderId is already in the
  // shared normal form (ImsgChannel.normalizeAddress → normalizeImessageHandle).
  const wire = (raw: string) => normalizeImessageHandle(raw);
  beforeEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("normalizeHandle IS normalizeImessageHandle for iMessage", () => {
    const cases: Array<[string, string]> = [
      ["1 (415) 555-1234", "+14155551234"],
      ["+14155551234", "+14155551234"],
      ["+1 (415) 555-1234", "+14155551234"],
      ["4155551234", "4155551234"],
      ["Foo@Bar.COM", "foo@bar.com"],
      [" +86 138 0013 8000 ", "+8613800138000"],
      ["iMessage;-;+14155551234", "+14155551234"],
      ["urn:biz:1234-abc", "urn:biz:1234-abc"],
      ["tel:+14155551234", "+14155551234"],
      ["TEL:+1 (415) 555-1234", "+14155551234"],
      ["sms:+8613800138000", "+8613800138000"],
      ["mailto:Foo@Bar.COM", "foo@bar.com"],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeHandle("imessage", raw)).toBe(expected);
      expect(normalizeHandle("imessage", raw)).toBe(normalizeImessageHandle(raw));
    }
    // Other channels are only trimmed, as before.
    expect(normalizeHandle("telegram", " 12345 ")).toBe("12345");
  });

  /** Find the record whose STORED imessage value is `stored` by a sender id. */
  function matchStored(stored: string, sender: string): boolean {
    const record = parsePersonFile(`---\nname: P\nimessage: ${stored}\n---\n`, "/x/p.md", false);
    if (!record) throw new Error("fixture did not parse");
    return findPersonByHandle([record], "imessage", wire(sender)) !== undefined;
  }

  it("records written in any earlier form still match the sender", () => {
    // Hand-written, written by the OLD upsert ("1 (415) 555-1234" → "14155551234"),
    // already E.164, legacy decorations, international, email, DM GUID.
    const sender = "+14155551234";
    for (const stored of [
      "+1 (415) 555-1234",
      "1 (415) 555-1234",
      "14155551234",
      "+14155551234",
      "tel:+14155551234",
      "+1 415 555 1234 (cell)",
      "iMessage;-;+14155551234",
    ]) {
      expect(matchStored(stored, sender), stored).toBe(true);
    }
    expect(matchStored("+86 138 0013 8000", "+8613800138000")).toBe(true);
    expect(matchStored("Foo@Bar.COM", "foo@bar.com")).toBe(true);
    expect(matchStored("4155551234", "4155551234")).toBe(true);
  });

  it("every stored/sender pair the old people normalizer matched still matches", () => {
    // Frozen copy of the pre-unification people.ts normalizer, as an oracle.
    const legacy = (v: string) => {
      const t = v.trim();
      return t.includes("@") ? t.toLowerCase() : t.replace(/[^\d+]/g, "");
    };
    const stored = [
      "+1 (415) 555-1234", "+14155551234", "+86 138 0013 8000", "+44 20 7946 0958",
      "tel:+14155551234", "Foo@Bar.COM", "iMessage;-;+14155551234", "4155551234",
    ];
    const senders = ["+14155551234", "+8613800138000", "+442079460958", "foo@bar.com", "4155551234"];
    for (const s of stored) {
      for (const sender of senders) {
        if (legacy(s) === legacy(sender)) expect(matchStored(s, sender), `${s} vs ${sender}`).toBe(true);
      }
    }
  });

  it("a URI scheme on either side does not stop a match", () => {
    expect(matchStored("+14155551234", "tel:+14155551234")).toBe(true);
    expect(matchStored("tel:+14155551234", "tel:+14155551234")).toBe(true);
    expect(matchStored("+8613800138000", "sms:+86 138 0013 8000")).toBe(true);
    expect(matchStored("foo@bar.com", "mailto:Foo@Bar.COM")).toBe(true);
    expect(findPersonByHandle(
      [parsePersonFile("---\nname: P\nimessage: +14155551234\n---\n", "/x/p.md", false)!],
      "imessage", "tel:+14155551234",
    )).toBeDefined();
  });

  it("no longer matches across countries or folds non-phone ids into digits", () => {
    // A bare 10-digit number has no country: it must not match +1…, and
    // never did. (Sweden's +46 95 550 123 vs a bare 4695550123 is the
    // case normalizeImessageHandle exists to keep apart.)
    expect(matchStored("4155551234", "+14155551234")).toBe(false);
    expect(matchStored("4695550123", "+4695550123")).toBe(false);
    // The old normalizer reduced a business-chat URN to "1234".
    expect(matchStored("urn:biz:1234-abc", "1234")).toBe(false);
    expect(matchStored("urn:biz:1234-abc", "urn:biz:1234-abc")).toBe(true);
  });

  it("upsert and auto-bind store the shared normal form", () => {
    const { record } = upsertPerson({ name: "Nina", imessage: "1 (415) 555-1234" }, { includePrivate: false, dirs });
    expect(record.handles.imessage).toBe("+14155551234");
    expect(readFileSync(record.filePath, "utf-8")).toContain("imessage: +14155551234");

    writePerson(dirs.publicDir, "omar.md", "---\nname: Omar\n---\n");
    const bound = autoBindHandle("imessage", wire("+86 138 0013 8000"), "Omar", dirs);
    expect(bound?.handles.imessage).toBe("+8613800138000");
  });
});

describe("loadPeople strict", () => {
  const root = join(TEST_DIR, "strict");
  const strictDirs: PeopleDirs = { publicDir: join(root, "pub", "people"), privateDir: join(root, "priv", "people") };
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a missing directory is an empty roster, strict or not", () => {
    expect(loadPeople({ includePrivate: true, dirs: strictDirs, strict: true })).toEqual([]);
  });

  it("an unreachable parent (existsSync says false) throws instead of reading as nobody", () => {
    // A symlink that points at itself: every lookup through it is ELOOP, for
    // every uid. That is the same symptom as a parent the user cannot search
    // (EACCES; chmod 000 would not show it under root, which reads through
    // the mode): existsSync() answers false, yet it is not "no directory".
    mkdirSync(root, { recursive: true });
    symlinkSync(join(root, "pub"), join(root, "pub"));
    expect(existsSync(strictDirs.publicDir)).toBe(false);
    expect(() => loadPeople({ includePrivate: false, dirs: strictDirs, strict: true })).toThrow(/ELOOP/);
    expect(loadPeople({ includePrivate: false, dirs: strictDirs })).toEqual([]);
  });
});

/**
 * A broken person file is worth one log line, not one per message.
 *
 * `loadPeople` runs on the inbound path — several times per message before the
 * request-scoped snapshot, once per message after it — and every one of those
 * loads re-read the same malformed record and re-warned about it. A single
 * hand-edited or half-written file therefore produced a warning per message,
 * indefinitely, and buried the log it was written to be visible in.
 */
describe("loadPeople — malformed person file warnings", () => {
  const root = join(TEST_DIR, "warn-once");
  let warn: MockInstance<typeof log.warn>;
  beforeEach(() => { warn = vi.spyOn(log, "warn").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  const GOOD = "---\nname: Kevin Wang\n---\n\nNotes.\n";

  /** Fresh directories per test — the memo is keyed by path and lives for the
   *  process, so two tests sharing a filename would be testing each other. */
  function dirsFor(id: string): PeopleDirs {
    const publicDir = join(root, id, "people");
    mkdirSync(publicDir, { recursive: true });
    return { publicDir, privateDir: join(root, id, "private", "people") };
  }

  function warningsMatching(needle: string): unknown[][] {
    return warn.mock.calls.filter((call) => String(call[1] ?? "").includes(needle));
  }

  it("warns once per process, not once per load", () => {
    const dirs = dirsFor("repeat");
    writeFileSync(join(dirs.publicDir, "torn.md"), "no frontmatter here\n", "utf-8");

    for (let i = 0; i < 5; i++) loadPeople({ includePrivate: false, dirs });

    expect(warningsMatching("no usable frontmatter")).toHaveLength(1);
  });

  it("names a torn record and still loads the records around it on every load", () => {
    const dirs = dirsFor("around");
    // Exactly what a truncated write leaves: an opening fence and half a
    // frontmatter. `parsePersonFile` returns undefined, and without the
    // warning the person would stop being recognised with nothing saying why.
    writeFileSync(join(dirs.publicDir, "torn.md"), "---\nname: Ke", "utf-8");
    writeFileSync(join(dirs.publicDir, "kevin.md"), GOOD, "utf-8");

    expect(loadPeople({ includePrivate: false, dirs }).map((p) => p.name)).toEqual(["Kevin Wang"]);
    expect(loadPeople({ includePrivate: false, dirs })).toHaveLength(1);
    const warned = warningsMatching("no usable frontmatter");
    expect(warned).toHaveLength(1);
    expect(warned[0][0]).toMatchObject({ filePath: join(dirs.publicDir, "torn.md") });
  });

  it("warns again after the file is repaired and broken a second time", () => {
    const dirs = dirsFor("repaired");
    const path = join(dirs.publicDir, "kevin.md");

    writeFileSync(path, "torn\n", "utf-8");
    loadPeople({ includePrivate: false, dirs });
    loadPeople({ includePrivate: false, dirs });
    expect(warningsMatching("no usable frontmatter")).toHaveLength(1);

    // Repaired: the memo for this path is cleared by a load that parses it.
    writeFileSync(path, GOOD, "utf-8");
    expect(loadPeople({ includePrivate: false, dirs })).toHaveLength(1);

    // Broken again — a new fact, said again rather than swallowed for the life
    // of the daemon.
    writeFileSync(path, "torn again\n", "utf-8");
    loadPeople({ includePrivate: false, dirs });
    loadPeople({ includePrivate: false, dirs });
    expect(warningsMatching("no usable frontmatter")).toHaveLength(2);
  });

  it("warns once per file, so two broken records are both named", () => {
    const dirs = dirsFor("two");
    writeFileSync(join(dirs.publicDir, "a.md"), "torn\n", "utf-8");
    writeFileSync(join(dirs.publicDir, "b.md"), "torn\n", "utf-8");

    loadPeople({ includePrivate: false, dirs });
    loadPeople({ includePrivate: false, dirs });

    const paths = warningsMatching("no usable frontmatter")
      .map((call) => (call as [{ filePath: string }, string])[0].filePath);
    expect(paths.sort()).toEqual([join(dirs.publicDir, "a.md"), join(dirs.publicDir, "b.md")]);
  });
});
