import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "tomo-test-todo-mcp-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
vi.mock("../src/config.js", () => ({ config: { tomoHome: ROOT }, TOMO_HOME: ROOT }));

const { buildTodoTools, TODO_TOOL_NAMES } = await import("../src/mcp/todo-tools.js");
const { TodoStore } = await import("../src/todos/store.js");
const { MIXED_AUDIENCE_KEY } = await import("../src/agent/audience.js");

interface ToolHandle {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

const OWNER = "dm:shuai";
const GROUP = "telegram:-100777";
let dir: string;
beforeEach(() => { dir = join(ROOT, `c-${Math.random().toString(36).slice(2)}`); });

function tools(caller: string | undefined) {
  const list = buildTodoTools({ store: () => new TodoStore(dir), caller: () => caller }) as unknown as ToolHandle[];
  const get = (name: string) => list.find((t) => t.name === name)!;
  return {
    names: list.map((t) => t.name),
    add: (args: Record<string, unknown>) => get("todo_add").handler(args, {}),
    list: (filter?: string) => get("todo_list").handler(filter ? { filter } : { filter: "all" }, {}),
    resolve: (args: Record<string, unknown>) => get("todo_resolve").handler(args, {}),
  };
}

describe("todo MCP tools", () => {
  it("are exactly three, and the allowed-tools list names them", () => {
    expect(tools(OWNER).names).toEqual(["todo_add", "todo_list", "todo_resolve"]);
    expect([...TODO_TOOL_NAMES]).toEqual(["todo_add", "todo_list", "todo_resolve"]);
  });

  it("todo_add files the item under the caller's session, source self", async () => {
    const result = await tools(GROUP).add({ title: "Book the restaurant", next: "Call them Friday", waiting_on: "me" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/^Added t-1 Book the restaurant · next: Call them Friday · waiting on me · review /);
    const [item] = new TodoStore(dir).list();
    expect(item).toMatchObject({ session: GROUP, source: "self" });
  });

  it("todo_add refuses without a single conversation to file under", async () => {
    for (const caller of [undefined, MIXED_AUDIENCE_KEY]) {
      const result = await tools(caller).add({ title: "x", next: "y", waiting_on: "me" });
      expect(result.isError).toBe(true);
    }
    expect(new TodoStore(dir).list()).toEqual([]);
  });

  it("rule violations come back as tool errors, not throws", async () => {
    const t = tools(OWNER);
    const long = await t.add({ title: "x".repeat(121), next: "y", waiting_on: "me" });
    expect(long).toMatchObject({ isError: true });
    expect(long.content[0].text).toMatch(/^todo_add failed: title is 121 characters/);
    await t.add({ title: "a", next: "b", waiting_on: "me" });
    const drop = await t.resolve({ id: "t-1", action: "drop" });
    expect(drop.content[0].text).toMatch(/drop needs a reason/);
  });

  it("a group lists and resolves only its own items", async () => {
    await tools(OWNER).add({ title: "owner private errand", next: "x", waiting_on: "me" });
    await tools(GROUP).add({ title: "group trip", next: "x", waiting_on: "owner" });
    const groupList = (await tools(GROUP).list()).content[0].text;
    expect(groupList).toContain("group trip");
    expect(groupList).not.toContain("owner private errand");
    const steal = await tools(GROUP).resolve({ id: "t-1", action: "done" });
    expect(steal).toMatchObject({ isError: true });
    expect(steal.content[0].text).toMatch(/No open todo t-1 in this conversation/);
    const ownerList = (await tools(OWNER).list()).content[0].text;
    expect(ownerList).toContain("owner private errand");
    expect(ownerList).toContain("group trip");
    expect((await tools(OWNER).list("owner")).content[0].text).not.toContain("owner private errand");
    expect((await tools(OWNER).resolve({ id: "t-2", action: "done", evidence: "booked" })).content[0].text).toMatch(/^Done: t-2 group trip/);
  });

  it("todo_resolve snoozes, hands off and reports the cap", async () => {
    const t = tools(OWNER);
    await t.add({ title: "a", next: "b", waiting_on: "me" });
    for (let i = 0; i < 3; i++) {
      expect((await t.resolve({ id: "t-1", action: "snooze", until: "2d", reason: "busy" })).content[0].text).toMatch(/^Snoozed: t-1 a .* snoozed \d\/3/);
    }
    const capped = await t.resolve({ id: "t-1", action: "snooze", until: "2d", reason: "busy" });
    expect(capped).toMatchObject({ isError: true });
    expect((await t.resolve({ id: "t-1", action: "handoff", next: "Ask him" })).content[0].text).toMatch(/^Handed to the owner: t-1 a · next: Ask him · waiting on owner/);
  });

  it("a corrupt store is an error the model sees, and the file is not touched", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "todos.json"), "{ broken");
    for (const result of [
      await tools(OWNER).list(),
      await tools(OWNER).add({ title: "a", next: "b", waiting_on: "me" }),
      await tools(OWNER).resolve({ id: "t-1", action: "done" }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/todo store could not be read/);
    }
    expect(readFileSync(join(dir, "todos.json"), "utf-8")).toBe("{ broken");
  });
});
