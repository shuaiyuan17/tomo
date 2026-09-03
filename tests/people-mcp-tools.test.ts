import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildPeopleTools } from "../src/mcp/people-tools.js";
import type { PeopleDirs } from "../src/people.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "tomo-test-people-tools");
const dirs: PeopleDirs = {
  publicDir: join(TEST_DIR, "people"),
  privateDir: join(TEST_DIR, "private", "people"),
};

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type SdkTool = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> };

function getTool(tools: unknown[], name: string): SdkTool {
  const t = (tools as SdkTool[]).find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function writePerson(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf-8");
}

describe("people MCP tools", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("list_people returns records, excluding private ones for group callers", async () => {
    writePerson(dirs.publicDir, "kevin.md", `---\nname: Kevin Wang\naliases: kw\n---\nnotes here\n`);
    writePerson(dirs.privateDir, "secret.md", `---\nname: Secret Friend\n---\n`);

    const dmList = getTool(buildPeopleTools({ includePrivate: true, dirs }), "list_people");
    const dmResult = await dmList.handler({}, {});
    const dmNames = (JSON.parse(dmResult.content[0].text) as Array<{ name: string }>).map((p) => p.name);
    expect(dmNames.sort()).toEqual(["Kevin Wang", "Secret Friend"]);

    const groupList = getTool(buildPeopleTools({ includePrivate: false, dirs }), "list_people");
    const groupResult = await groupList.handler({}, {});
    const groupNames = (JSON.parse(groupResult.content[0].text) as Array<{ name: string }>).map((p) => p.name);
    expect(groupNames).toEqual(["Kevin Wang"]);
  });

  // One MCP server is built per live session, but a dm: session's audience
  // changes turn to turn while a group is summoned into it — so the flag is a
  // getter, resolved per call.
  it("resolves includePrivate per call, so a summoned-group turn sees no private records", async () => {
    writePerson(dirs.publicDir, "kevin.md", `---\nname: Kevin Wang\n---\n`);
    writePerson(dirs.privateDir, "secret.md", `---\nname: Secret Friend\n---\n`);

    let ownTurn = true;
    const tools = buildPeopleTools({ includePrivate: () => ownTurn, dirs });
    const list = getTool(tools, "list_people");
    const upsert = getTool(tools, "upsert_person");

    const dmNames = (JSON.parse((await list.handler({}, {})).content[0].text) as Array<{ name: string }>)
      .map((p) => p.name);
    expect(dmNames.sort()).toEqual(["Kevin Wang", "Secret Friend"]);

    // Same tool objects, next turn — a group is now steering this session.
    ownTurn = false;
    const summonedNames = (JSON.parse((await list.handler({}, {})).content[0].text) as Array<{ name: string }>)
      .map((p) => p.name);
    expect(summonedNames).toEqual(["Kevin Wang"]);

    // ...and cannot reach the private subtree by writing into it either.
    const refused = await upsert.handler(
      { name: "Someone Else", replace_aliases: false, private: true },
      {},
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("can only be used from a DM session");

    // The record is matched against public records only, so a private record
    // cannot be updated (or even confirmed to exist) from a summoned turn.
    const created = await upsert.handler(
      { name: "Secret Friend", replace_aliases: false },
      {},
    );
    expect(created.content[0].text).toContain("Created person record");
    expect(created.content[0].text).not.toContain("private");
  });

  it("upsert_person creates and then updates by alias", async () => {
    const upsert = getTool(buildPeopleTools({ includePrivate: true, dirs }), "upsert_person");

    const created = await upsert.handler(
      { name: "Kevin Wang", aliases: ["kw"], replace_aliases: false },
      {},
    );
    expect(created.isError).toBeUndefined();
    expect(created.content[0].text).toContain("Created person record");

    const updated = await upsert.handler(
      { name: "Kevin Wang", match: "kw", aliases: ["嘉伟"], replace_aliases: false, notes: "climbing buddy" },
      {},
    );
    expect(updated.content[0].text).toContain("Updated person record");
    expect(updated.content[0].text).toContain("嘉伟");
  });

  it("upsert_person rejects the private flag for group callers", async () => {
    const upsert = getTool(buildPeopleTools({ includePrivate: false, dirs }), "upsert_person");
    const result = await upsert.handler(
      { name: "X", replace_aliases: false, private: true },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DM session");
  });

  it("upsert_person writes, canonicalizes and clears a timezone, and list_people shows it", async () => {
    const tools = buildPeopleTools({ includePrivate: true, dirs });
    const upsert = getTool(tools, "upsert_person");
    const list = getTool(tools, "list_people");

    const created = await upsert.handler(
      { name: "Alice Example", replace_aliases: false, timezone: "asia/tokyo" },
      {},
    );
    expect(created.isError).toBeUndefined();
    expect(created.content[0].text).toContain("\"timezone\": \"Asia/Tokyo\"");

    const listed = JSON.parse((await list.handler({}, {})).content[0].text) as Array<{ name: string; timezone?: string }>;
    expect(listed.find((p) => p.name === "Alice Example")?.timezone).toBe("Asia/Tokyo");

    const cleared = await upsert.handler(
      { name: "Alice Example", replace_aliases: false, timezone: "" },
      {},
    );
    expect(cleared.content[0].text).not.toContain("timezone");
    const relisted = JSON.parse((await list.handler({}, {})).content[0].text) as Array<{ timezone?: string }>;
    expect(relisted[0].timezone).toBeUndefined();
  });

  it("upsert_person reports an invalid timezone as a tool error, not a crash", async () => {
    const upsert = getTool(buildPeopleTools({ includePrivate: true, dirs }), "upsert_person");
    const result = await upsert.handler(
      { name: "Alice Example", replace_aliases: false, timezone: "Not/AZone" },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a valid IANA time zone");
  });

  it("upsert_person surfaces ambiguity errors instead of guessing", async () => {
    writePerson(dirs.publicDir, "a1.md", `---\nname: Alice Smith\naliases: alice\n---\n`);
    writePerson(dirs.publicDir, "a2.md", `---\nname: Alice Jones\naliases: alice\n---\n`);
    const upsert = getTool(buildPeopleTools({ includePrivate: true, dirs }), "upsert_person");
    const result = await upsert.handler({ name: "alice", replace_aliases: false }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("matches 2 people");
  });
});
