import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, agentEnv, installAgentTestHooks, mockSdk, resetConfig, sdkMock } from "./helpers/agent-harness.js";
import { TodoStore, todosDir } from "../src/todos/store.js";
import { parseTodoArgs, TODO_USAGE } from "../src/agent/todo-command.js";
import { CHAT_COMMAND_NAMES } from "../src/channels/chat-commands.js";

installAgentTestHooks();

const OWNER_ID = "12345";
const GROUP = "-100777";
const OTHER_GROUP = "-100888";

function setup() {
  resetConfig({
    identities: [{ name: "shuai", channels: { telegram: OWNER_ID }, replyPolicy: "last-active" }],
    channelAllowlists: { telegram: [OWNER_ID, GROUP, OTHER_GROUP] },
  });
  const store = new TodoStore(todosDir());
  store.add({ title: "owner private errand", next: "x", waiting_on: "me", session: "dm:shuai", source: "self" });
  store.add({ title: "group trip planning", next: "x", waiting_on: "owner", session: `telegram:${GROUP}`, source: "self" });
  store.add({ title: "other group secret", next: "x", waiting_on: "me", session: `telegram:${OTHER_GROUP}`, source: "self" });
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  const queryCalls = () => (sdkMock.query as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  return { agent, tg, store, queryCalls };
}

describe("parseTodoArgs", () => {
  it("accepts the four forms and nothing else", () => {
    expect(parseTodoArgs("")).toEqual({ kind: "list", all: false });
    expect(parseTodoArgs(" ALL ")).toEqual({ kind: "list", all: true });
    expect(parseTodoArgs("add Call the bank")).toEqual({ kind: "add", text: "Call the bank" });
    expect(parseTodoArgs("done T-12")).toEqual({ kind: "done", id: "T-12" });
    expect(parseTodoArgs("drop t-3 not needed")).toEqual({ kind: "drop", id: "t-3", reason: "not needed" });
    expect(parseTodoArgs("drop t-3")).toEqual({ kind: "drop", id: "t-3" });
    for (const bad of ["add", "done", "done 12", "done t-1 extra", "snooze t-1 3d", "comment t-1 hi", "all x"]) {
      expect(parseTodoArgs(bad), bad).toBeUndefined();
    }
  });

  it("is routed by every channel", () => {
    expect(CHAT_COMMAND_NAMES).toContain("todo");
  });
});

describe("/todo chat command", () => {
  it("lists in the owner DM without calling the model", async () => {
    const { agent, tg, queryCalls } = setup();
    const before = queryCalls();
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", undefined, OWNER_ID);
    expect(tg.sent).toHaveLength(1);
    const text = tg.sent[0].text;
    expect(text).toMatch(/^Todos · 3 open \(1 waiting on you, 2 on me, 0 on others\)/);
    expect(text.indexOf("t-2 group trip planning")).toBeLessThan(text.indexOf("t-1 owner private errand"));
    expect(text).not.toMatch(/[*_`#]/);
    expect(queryCalls()).toBe(before);
    expect(mockSdk.promptsBySession).toEqual([]);
    await agent.stop();
  });

  it("add, done and drop write through the store", async () => {
    const { agent, tg, store, queryCalls } = setup();
    const before = queryCalls();
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", "add Renew the passport", OWNER_ID);
    expect(tg.sent[0].text).toMatch(/^Added t-4 Renew the passport · waiting on me · review /);
    expect(store.list().find((i) => i.id === "t-4")).toMatchObject({ source: "owner", session: "dm:shuai", next: "Renew the passport" });
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", "done t-4", OWNER_ID);
    expect(tg.sent[1].text).toBe("Done: t-4 Renew the passport");
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", "drop t-2 changed plans", OWNER_ID);
    expect(tg.sent[2].text).toBe("Dropped: t-2 group trip planning");
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", "done t-99", OWNER_ID);
    expect(tg.sent[3].text).toBe("No open todo t-99 in this conversation.");
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", "snooze t-1", OWNER_ID);
    expect(tg.sent[4].text).toBe(TODO_USAGE);
    expect(store.list().map((i) => i.id)).toEqual(["t-1", "t-3"]);
    const log = readFileSync(join(todosDir(), "done.ndjson"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toEqual([
      expect.objectContaining({ id: "t-4", resolution: "done", resolved_by: "owner" }),
      expect.objectContaining({ id: "t-2", resolution: "drop", reason: "changed plans", resolved_by: "owner" }),
    ]);
    expect(queryCalls()).toBe(before);
    await agent.stop();
  });

  it("in a group, shows only that group's items, and only the owner may change them", async () => {
    const { agent, tg, store } = setup();
    await tg.simulateCommand("todo", GROUP, "Member", undefined, "99999");
    expect(tg.sent[0].chatId).toBe(GROUP);
    expect(tg.sent[0].text).toContain("group trip planning");
    expect(tg.sent[0].text).not.toContain("owner private errand");
    expect(tg.sent[0].text).not.toContain("other group secret");
    await tg.simulateCommand("todo", GROUP, "Member", "add Buy snacks", "99999");
    expect(tg.sent[1].text).toBe("Only the owner can change todos.");
    // The owner, not summoned: the group's own scope — another chat's item is out of reach.
    await tg.simulateCommand("todo", GROUP, "Shuai", "done t-1", OWNER_ID);
    expect(tg.sent[2].text).toBe("No open todo t-1 in this conversation.");
    await tg.simulateCommand("todo", GROUP, "Shuai", "add Buy snacks", OWNER_ID);
    expect(store.list().find((i) => i.title === "Buy snacks")).toMatchObject({ session: `telegram:${GROUP}`, source: "owner" });
    expect(store.list()).toHaveLength(4);
    await agent.stop();
  });

  it("in a summoned group, sends the owner's list to the owner's DM only", async () => {
    const { agent, tg } = setup();
    await tg.simulateCommand("status", OWNER_ID, "Shuai", undefined, OWNER_ID);
    await tg.simulateCommand("summon", GROUP, "Shuai", undefined, OWNER_ID);
    tg.clearDelivered();
    await tg.simulateCommand("todo", GROUP, "Shuai", undefined, OWNER_ID);
    expect(tg.sent.filter((m) => m.chatId === GROUP).map((m) => m.text)).toEqual(["Sent to your DM."]);
    const dm = tg.sent.filter((m) => m.chatId === OWNER_ID);
    expect(dm).toHaveLength(1);
    expect(dm[0].text).toContain("owner private errand");
    tg.clearDelivered();
    await tg.simulateCommand("todo", GROUP, "Member", undefined, "99999");
    expect(tg.sent.map((m) => m.chatId)).toEqual([GROUP]);
    expect(tg.sent[0].text).not.toContain("owner private errand");
    await agent.stop();
  });

  it("says the store is unreadable rather than empty", async () => {
    const { agent, tg } = setup();
    mkdirSync(todosDir(), { recursive: true });
    writeFileSync(join(todosDir(), "todos.json"), "{ broken");
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", undefined, OWNER_ID);
    await tg.simulateCommand("todo", OWNER_ID, "Shuai", "add x", OWNER_ID);
    for (const sent of tg.sent) expect(sent.text).toMatch(/^Todos are unavailable: todo store could not be read/);
    expect(readFileSync(join(todosDir(), "todos.json"), "utf-8")).toBe("{ broken");
    expect(agentEnv.tmpDir).toBeTruthy();
    await agent.stop();
  });
});
