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

  it("upsert_person surfaces ambiguity errors instead of guessing", async () => {
    writePerson(dirs.publicDir, "a1.md", `---\nname: Alice Smith\naliases: alice\n---\n`);
    writePerson(dirs.publicDir, "a2.md", `---\nname: Alice Jones\naliases: alice\n---\n`);
    const upsert = getTool(buildPeopleTools({ includePrivate: true, dirs }), "upsert_person");
    const result = await upsert.handler({ name: "alice", replace_aliases: false }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("matches 2 people");
  });
});
