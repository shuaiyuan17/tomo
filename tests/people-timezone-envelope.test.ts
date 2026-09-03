import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// The sender's local clock on the INBOUND MESSAGE ENVELOPE, end to end: a real
// Agent, a real people registry on disk, and the prompt the SDK actually
// receives.
//
// Why the envelope and not the system prompt: the participants block is
// prompt-cached, so a value that moves with the wall clock would invalidate
// the cache on every request. This line is rebuilt for every message anyway.
//
// The host zone is pinned before the Agent ever formats a stamp, so "the
// sender is somewhere else" and "the sender is right here" are both decidable
// facts rather than properties of whichever machine runs the suite.
// ---------------------------------------------------------------------------

const HOST_TZ = "America/Los_Angeles";
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = HOST_TZ;

// The people registry resolves its directories from `defaultRuntimePaths`
// (src/people.ts `defaultPeopleDirs`), which the Agent does not let a caller
// override. Point it at a tmp home so the real registry is never touched.
vi.mock("../src/runtime-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-paths.js")>();
  const path = await import("node:path");
  const os = await import("node:os");
  const home = path.join(os.tmpdir(), "tomo-test-people-timezone");
  return {
    ...actual,
    defaultRuntimePaths: actual.createRuntimePaths({
      homeDir: home,
      tomoHome: path.join(home, ".tomo"),
      workspaceDir: path.join(home, "workspace"),
    }),
  };
});
vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockSdk,
  resetConfig,
} from "./helpers/agent-harness.js";

installAgentTestHooks();

const HOME = join(tmpdir(), "tomo-test-people-timezone");
const MEMORY = join(HOME, "workspace", "memory");
const GROUP_CHAT_ID = "-1002000";
const OWNER = { name: "owner", channels: { telegram: "12345" }, replyPolicy: "last-active" as const };

/** A zone that is never the host's here, and never observes daylight saving. */
const SENDER_TZ = "Asia/Tokyo";

/** The stamp shape as it was BEFORE this feature: no sender segment at all. */
const STAMP_WITHOUT_SENDER = /^\[telegram · \w{3} \d{2}\/\d{2} \d{2}:\d{2} [^\]]{2,8}\] /;
/** The stamp shape WITH one: `· sender <mm/dd> <hh:mm> <zone>` before the `]`. */
const STAMP_WITH_SENDER = /^\[telegram · \w{3} \d{2}\/\d{2} \d{2}:\d{2} [A-Z]{2,5} · sender (\d{2}\/\d{2} \d{2}:\d{2} \S+)\] /;

function writePerson(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf-8");
}

function publicPerson(file: string, content: string): void {
  writePerson(join(MEMORY, "people"), file, content);
}

function privatePerson(file: string, content: string): void {
  writePerson(join(MEMORY, "private", "people"), file, content);
}

/**
 * The clock the sender segment should read for an instant, computed here with
 * plain `Intl` rather than with the formatter under test — so a broken
 * conversion cannot agree with itself.
 */
function expectedClock(at: number, timeZone: string): string {
  const d = new Date(at);
  const date = d.toLocaleDateString("en-US", { timeZone, month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const zone = d.toLocaleTimeString("en-US", { timeZone, timeZoneName: "short" }).split(" ").pop();
  return `${date} ${time} ${zone}`;
}

/** Run a turn and return the prompt text the SDK saw. */
async function promptFor(msg: Parameters<typeof makeMsg>[0]): Promise<{ prompt: string; from: number; to: number }> {
  resetConfig({ identities: [OWNER] });
  const agent = new Agent();
  const tg = new MockChannel("telegram");
  agent.addChannel(tg);
  mockSdk.responseFn = () => "ok";
  // Some tests run two turns; only this one's prompt is of interest.
  mockSdk.promptsBySession = [];

  const from = Date.now();
  await tg.simulateMessage(makeMsg(msg));
  await drainQueue(agent);
  const to = Date.now();
  await agent.stop();

  const prompts = mockSdk.promptsBySession.map((p) => p.text);
  expect(prompts).toHaveLength(1);
  return { prompt: prompts[0], from, to };
}

/** The captured segment must match one of the minutes the turn spanned. */
function expectClock(segment: string, from: number, to: number, timeZone: string): void {
  expect([expectedClock(from, timeZone), expectedClock(to, timeZone)]).toContain(segment);
}

describe("sender-local time on the inbound envelope", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(MEMORY, { recursive: true });
    process.env.TZ = HOST_TZ;
  });

  afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it("stamps a group message with the sender's local clock", async () => {
    publicPerson("alice.md", `---\nname: Alice Example\naliases: ali\ntelegram: 5001\ntimezone: ${SENDER_TZ}\n---\n`);

    const { prompt, from, to } = await promptFor({
      chatId: GROUP_CHAT_ID,
      text: "@tomo are you around?",
      isGroup: true,
      isMentioned: true,
      senderName: "ali",
      senderId: "5001",
    });

    const match = STAMP_WITH_SENDER.exec(prompt);
    expect(match, `no sender segment in: ${prompt}`).not.toBeNull();
    expectClock(match![1], from, to, SENDER_TZ);
    // The sender line itself is untouched by any of this.
    expect(prompt).toContain("ali (Alice Example): @tomo are you around?");
  });

  it("leaves the envelope exactly as it was for a sender with no timezone", async () => {
    publicPerson("bob.md", `---\nname: Bob Example\ntelegram: 5002\n---\n`);

    const { prompt } = await promptFor({
      chatId: GROUP_CHAT_ID,
      text: "@tomo hello",
      isGroup: true,
      isMentioned: true,
      senderName: "Bob Example",
      senderId: "5002",
    });

    expect(prompt).toMatch(STAMP_WITHOUT_SENDER);
    expect(prompt).not.toContain("· sender");
  });

  it("adds nothing for an unresolvable sender or an unusable timezone", async () => {
    publicPerson("carol.md", `---\nname: Carol Example\ntelegram: 5003\ntimezone: Not/AZone\n---\n`);

    const broken = await promptFor({
      chatId: GROUP_CHAT_ID,
      text: "@tomo hello",
      isGroup: true,
      isMentioned: true,
      senderName: "Carol Example",
      senderId: "5003",
    });
    expect(broken.prompt).toMatch(STAMP_WITHOUT_SENDER);
    expect(broken.prompt).not.toContain("· sender");

    const stranger = await promptFor({
      chatId: GROUP_CHAT_ID,
      text: "@tomo hello",
      isGroup: true,
      isMentioned: true,
      senderName: "Nobody In The Registry",
      senderId: "9999",
    });
    expect(stranger.prompt).toMatch(STAMP_WITHOUT_SENDER);
    expect(stranger.prompt).not.toContain("· sender");
  });

  it("adds nothing when the sender keeps the same clock as the host", async () => {
    publicPerson("dan.md", `---\nname: Dan Example\ntelegram: 5004\ntimezone: ${HOST_TZ}\n---\n`);

    const { prompt } = await promptFor({
      chatId: GROUP_CHAT_ID,
      text: "@tomo hello",
      isGroup: true,
      isMentioned: true,
      senderName: "Dan Example",
      senderId: "5004",
    });

    expect(prompt).toMatch(STAMP_WITHOUT_SENDER);
    expect(prompt).not.toContain("· sender");
  });

  it("never spends a private record's timezone on a group message", async () => {
    // Same human, private record: DM-only, and a group message must not be
    // able to tell that a record for this sender exists at all.
    privatePerson("erin.md", `---\nname: Erin Example\ntelegram: 5005\ntimezone: ${SENDER_TZ}\n---\n`);

    const group = await promptFor({
      chatId: GROUP_CHAT_ID,
      text: "@tomo hello",
      isGroup: true,
      isMentioned: true,
      senderName: "Erin Example",
      senderId: "5005",
    });
    expect(group.prompt).toMatch(STAMP_WITHOUT_SENDER);
    expect(group.prompt).not.toContain("· sender");

    // The owner's own DM, where private records are in scope, still gets it.
    const dm = await promptFor({
      chatId: "12345",
      text: "hello",
      senderName: "Erin Example",
      senderId: "5005",
    });
    const match = /· sender (\d{2}\/\d{2} \d{2}:\d{2} \S+)\]/.exec(dm.prompt);
    expect(match, `no sender segment in: ${dm.prompt}`).not.toBeNull();
    expectClock(match![1], dm.from, dm.to, SENDER_TZ);
  });
});
