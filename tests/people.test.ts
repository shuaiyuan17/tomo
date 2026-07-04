import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  annotateSenderName,
  autoBindHandle,
  findPersonByHandle,
  findPersonByName,
  loadPeople,
  normalizeHandle,
  parsePersonFile,
  renderParticipantLabels,
  renderPeopleRoster,
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
});
