import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, installAgentTestHooks, mockSdk, resetConfig, sdkMock } from "./helpers/agent-harness.js";
import { TaskBoard } from "../src/web/tasks.js";
import type { WatchTask } from "../src/watch/protocol.js";

installAgentTestHooks();

const OWNER_ID = "12345";
const GROUP = "-100777";
const OTHER_GROUP = "-100888";
const task = (taskId: string, description: string): WatchTask => ({
  taskId, taskType: "local_agent", description, ambient: false, background: true, startedAt: Date.now() });

function setup() {
  resetConfig({
    identities: [{ name: "shuai", channels: { telegram: OWNER_ID }, replyPolicy: "last-active" }],
    channelAllowlists: { telegram: [OWNER_ID, GROUP, OTHER_GROUP] },
  });
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  const board = new TaskBoard(() => {});
  board.apply("dm:shuai", [task("p1", "owner private errand")]);
  board.apply(`telegram:${GROUP}`, [task("g1", "group trip planning")]);
  board.apply(`telegram:${OTHER_GROUP}`, [task("o1", "other group secret")]);
  agent.setTaskSource(board);
  const queryCalls = () => (sdkMock.query as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  return { agent, tg, board, queryCalls };
}

describe("/tasks chat command", () => {
  it("answers in the owner DM with the owner's tasks, without calling the model", async () => {
    const { agent, tg, board, queryCalls } = setup();
    const before = queryCalls();
    await tg.simulateCommand("tasks", OWNER_ID, "Shuai", undefined, OWNER_ID);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].text).toMatch(/^Tasks · 1 running, 0 done today\n▶ owner private errand · agent · \d+s$/);
    expect(queryCalls()).toBe(before);
    expect(mockSdk.promptsBySession).toEqual([]);
    board.dispose();
    await agent.stop();
  });

  it("in a group, lists only that group's own tasks", async () => {
    const { agent, tg, board } = setup();
    // A member, and the owner too (not summoned): the group's own session only.
    await tg.simulateCommand("tasks", GROUP, "Member", undefined, "99999");
    await tg.simulateCommand("tasks", GROUP, "Shuai", "all", OWNER_ID);
    expect(tg.sent).toHaveLength(2);
    for (const sent of tg.sent) {
      expect(sent.chatId).toBe(GROUP);
      expect(sent.text).toContain("group trip planning");
      expect(sent.text).not.toContain("owner private errand");
      expect(sent.text).not.toContain("other group secret");
    }
    board.dispose();
    await agent.stop();
  });

  it("in a summoned group, sends the owner's list to the owner's DM only; anyone else gets the group's", async () => {
    const { agent, tg, board } = setup();
    // The owner has written from their DM, so it is the reply target.
    await tg.simulateCommand("status", OWNER_ID, "Shuai", undefined, OWNER_ID);
    await tg.simulateCommand("summon", GROUP, "Shuai", undefined, OWNER_ID);
    tg.clearDelivered();
    await tg.simulateCommand("tasks", GROUP, "Shuai", undefined, OWNER_ID);
    const toGroup = tg.sent.filter((m) => m.chatId === GROUP);
    const toDm = tg.sent.filter((m) => m.chatId === OWNER_ID);
    expect(toGroup.map((m) => m.text)).toEqual(["Sent to your DM."]);
    expect(toDm).toHaveLength(1);
    expect(toDm[0].text).toContain("owner private errand");
    expect(toDm[0].text).not.toContain("group trip planning");
    tg.clearDelivered();
    await tg.simulateCommand("tasks", GROUP, "Member", undefined, "99999");
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].chatId).toBe(GROUP);
    expect(tg.sent[0].text).toContain("group trip planning");
    expect(tg.sent[0].text).not.toContain("owner private errand");
    board.dispose();
    await agent.stop();
  });

  it("in a summoned group, never posts the owner's list in the group when the DM is unreachable", async () => {
    const { agent, tg, board } = setup();
    await tg.simulateCommand("summon", GROUP, "Shuai", undefined, OWNER_ID);
    tg.clearDelivered();
    const realSend = tg.send.bind(tg);
    tg.send = async (message) => {
      if (message.chatId === OWNER_ID) throw new Error("DM down");
      return realSend(message);
    };
    await tg.simulateCommand("tasks", GROUP, "Shuai", undefined, OWNER_ID);
    expect(tg.sent.map((m) => [m.chatId, m.text])).toEqual([[GROUP, "Couldn't reach your DM."]]);
    board.dispose();
    await agent.stop();
  });

  it("says when there is nothing, and when there is no board", async () => {
    const { agent, tg, board } = setup();
    board.apply(`telegram:${GROUP}`, []);
    board.dispose();
    const empty = new TaskBoard(() => {});
    agent.setTaskSource(empty);
    await tg.simulateCommand("tasks", GROUP, "Member", undefined, "99999");
    expect(tg.sent[0].text).toBe("No tasks running.");
    await tg.simulateCommand("tasks", OWNER_ID, "Shuai", "bogus", OWNER_ID);
    expect(tg.sent[1].text).toBe("Usage: /tasks or /tasks all");
    await agent.stop();

    const bare = new Agent();
    const tg2 = new MockChannel("telegram");
    bare.addChannel(tg2);
    await tg2.simulateCommand("tasks", OWNER_ID, "Shuai", undefined, OWNER_ID);
    expect(tg2.sent[0].text).toContain("web UI is off");
    await bare.stop();
  });
});
