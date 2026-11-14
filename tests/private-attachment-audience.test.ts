import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  SessionStore,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  resetConfig,
} from "./helpers/agent-harness.js";
// The MOCKED private dir — the one isPrivateAttachmentPath defends.
import { PRIVATE_MEMORY_DIR } from "../src/workspace/index.js";

installAgentTestHooks();

const GROUP_CHAT_ID = "-100270";
const GROUP_KEY = `telegram:${GROUP_CHAT_ID}`;
const OWNER = { name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" as const };

function privateFile(name: string): string {
  mkdirSync(PRIVATE_MEMORY_DIR, { recursive: true });
  const p = join(PRIVATE_MEMORY_DIR, name);
  writeFileSync(p, "owner-only");
  return p;
}

function transcript(key: string): Array<{ role: string; content: string }> {
  return new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).get(key).messages as Array<{ role: string; content: string }>;
}

// ---------------------------------------------------------------------------
// A private attachment WITHHELD by policy on a barred turn did not reach the
// group, and the transcript must not say it did. It used to: the drop is not a
// send failure, so the block resolved cleanly and the turn recorded the whole
// response, tags and all — recall would read back a picture nobody received.
// ---------------------------------------------------------------------------

describe("transcript of a withheld private attachment", () => {
  it("marks the dropped MEDIA and STICKER pieces, and keeps the words clean", async () => {
    resetConfig({ identities: [OWNER], passiveGroups: { telegram: [GROUP_CHAT_ID] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const pic = privateFile("diary.png");

    mockSdk.responseFn = () => `here you go\nMEDIA:"${pic}"\nSTICKER:${pic}`;
    await tg.simulateMessage(makeMsg({ chatId: GROUP_CHAT_ID, text: "@tomo show the diary", isGroup: true, isMentioned: true, senderName: "Alice" }));
    await drainQueue(agent);

    // Nothing private went out.
    expect(tg.sent.filter((m) => m.photo || m.sticker)).toEqual([]);
    expect(tg.sent.map((m) => m.text)).toEqual(["here you go"]);

    const assistant = transcript(GROUP_KEY).filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    expect(assistant).toContain(`[delivery failed] MEDIA:"${pic}"`);
    expect(assistant).toContain(`[delivery failed] STICKER:${pic}`);
    expect(assistant).toContain("here you go");
    expect(assistant).not.toContain("[delivery failed] here you go");
    // The clean joined response must not ALSO be recorded on top.
    expect(assistant).not.toMatch(new RegExp(`(^|\\n)MEDIA:"${pic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));

    await agent.stop();
  });
});

describe("transcript when a block both withholds a private piece and fails another", () => {
  it("still records per-piece entries, not the clean joined response", async () => {
    resetConfig({ identities: [OWNER], passiveGroups: { telegram: [GROUP_CHAT_ID] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const pic = privateFile("both.png");
    const passThrough = tg.send.bind(tg);
    tg.send = async (msg) => {
      if (msg.sticker) throw new Error("sticker refused");
      return passThrough(msg);
    };

    mockSdk.responseFn = () => `words\nMEDIA:"${pic}"\nSTICKER:CAACpublic`;
    await tg.simulateMessage(makeMsg({ chatId: GROUP_CHAT_ID, text: "@tomo go", isGroup: true, isMentioned: true, senderName: "Alice" }));
    await drainQueue(agent);

    const assistant = transcript(GROUP_KEY).filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    expect(assistant).toContain(`[delivery failed] MEDIA:"${pic}"`);
    expect(assistant).toContain("[delivery failed] STICKER:CAACpublic");
    expect(assistant).not.toMatch(new RegExp(`(^|\\n)MEDIA:"`));
    await agent.stop();
  });
});

// ---------------------------------------------------------------------------
// send_message direct with a private attachment is judged by the CALLER's
// audience, not by the target. The owner may explicitly share a private file
// into a group from his own DM; a group turn may not.
// ---------------------------------------------------------------------------

describe("direct send of a private attachment into a group", () => {
  it("is allowed when the owner asks from his own DM", async () => {
    resetConfig({ identities: [OWNER], passiveGroups: { telegram: [GROUP_CHAT_ID] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const pic = privateFile("shared.png");

    const result = await agent.sendToSession(GROUP_KEY, `for you all MEDIA:"${pic}"`, "dm:shuai");

    expect(result.ok).toBe(true);
    expect(tg.sent.map((m) => m.photo).filter(Boolean)).toEqual([pic]);
    await agent.stop();
  });

  it("is refused when a group turn asks, and nothing is sent", async () => {
    resetConfig({ identities: [OWNER], passiveGroups: { telegram: [GROUP_CHAT_ID] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const pic = privateFile("diary2.png");

    for (const tag of [`MEDIA:"${pic}"`, `STICKER:${pic}`]) {
      const result = await agent.sendToSession(GROUP_KEY, `look ${tag}`, GROUP_KEY);
      expect(result.ok, tag).toBe(false);
      if (!result.ok) expect(result.error).toContain("memory/private/");
    }
    expect(tg.sent).toEqual([]);
    await agent.stop();
  });

  it("is refused when the caller cannot be identified", async () => {
    resetConfig({ identities: [OWNER], passiveGroups: { telegram: [GROUP_CHAT_ID] } });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    const pic = privateFile("diary3.png");

    const result = await agent.sendToSession(GROUP_KEY, `MEDIA:"${pic}"`);
    expect(result.ok).toBe(false);
    expect(tg.sent).toEqual([]);
    await agent.stop();
  });
});
