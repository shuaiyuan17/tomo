import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  annotateSenderName,
  autoBindHandle,
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
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-people");
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
aliases: kw, 嘉伟
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
    expect(record?.aliases).toEqual(["kw", "嘉伟"]);
    expect(record?.handles).toEqual({ telegram: "12345678", imessage: "+1 (415) 555-1234" });
    expect(record?.notes).toContain("Met at Stanford");
  });

  it("tolerates inline-array aliases, quotes, and full-width commas", () => {
    const record = parsePersonFile(
      `---\nname: "Alice Chen"\naliases: [阿丽、'ali']\n---\n`,
      "/tmp/a.md",
      false,
    );
    expect(record?.name).toBe("Alice Chen");
    expect(record?.aliases).toEqual(["阿丽", "ali"]);
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
    expect(findPersonByName(people, "嘉伟")?.name).toBe("Kevin Wang");
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
      expect(findPersonByDisplayName(people, "阿丽✨")).toBeUndefined();
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Chen\naliases: 阿丽\n---\n`);
      const reloaded = loadPeople({ includePrivate: false, dirs });
      expect(findPersonByDisplayName(reloaded, "阿丽✨")?.name).toBe("Alice Chen");
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
      expect(record.aliases).toEqual(["kw", "嘉伟", "Kev"]);
      expect(record.notes).toContain("Met at Stanford");
    });

    it("keeps the old canonical name as an alias on rename", () => {
      writePerson(dirs.publicDir, "kevin.md", KEVIN);
      const { record } = upsertPerson(
        { name: "Kevin W.", match: "嘉伟", aliases: [] },
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
      writePerson(dirs.publicDir, "alice.md", `---\nname: Alice Chen\naliases: 阿丽\n---\n`);
      const bound = autoBindHandle("telegram", "42", "阿丽", dirs);
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
        'Kevin Wang (aka: kw, 嘉伟; appears as "kw 🚀")',
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
      expect(annotateSenderName(people, "telegram", "嘉伟")).toBe("嘉伟 (Kevin Wang)");
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

    it("refuses an invalid identifier or a fixed offset instead of storing it", () => {
      expect(() => upsertPerson({ name: "Alice Example", timezone: "Not/AZone" }, { includePrivate: true, dirs }))
        .toThrow(/not a valid IANA time zone/);
      // A fixed offset would ignore daylight saving for half the year.
      expect(() => upsertPerson({ name: "Alice Example", timezone: "+09:00" }, { includePrivate: true, dirs }))
        .toThrow(/not a valid IANA time zone/);
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
