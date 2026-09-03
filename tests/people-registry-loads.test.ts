import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// ONE REGISTRY READ PER INBOUND MESSAGE.
//
// Loading the people registry is synchronous and proportional to its size: a
// readdir, then a stat and a readFile per record, on the path a message takes
// to the model. Handling one group message used to do that three times over
// (the transcript line, the prompt line, the sender's time zone) and a
// coalesced batch multiplied it by the item count.
//
// The counter below is the real disk read — `readdirSync` on the public people
// directory, which every load performs exactly once — rather than a spy on an
// exported function, so a refactor that reintroduces a load cannot hide behind
// module boundaries.
// ---------------------------------------------------------------------------

const HOME = join(tmpdir(), "tomo-test-people-registry-loads");
const MEMORY = join(HOME, "workspace", "memory");
const PUBLIC_PEOPLE_DIR = join(MEMORY, "people");

const counter = vi.hoisted(() => ({ registryLoads: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const path = await import("node:path");
  const os = await import("node:os");
  const publicPeopleDir = path.join(os.tmpdir(), "tomo-test-people-registry-loads", "workspace", "memory", "people");
  return {
    ...actual,
    // Delegates everything; the only change is the tally.
    readdirSync: ((p: Parameters<typeof actual.readdirSync>[0], opts?: unknown) => {
      if (String(p) === publicPeopleDir) counter.registryLoads++;
      return (actual.readdirSync as (a: unknown, b: unknown) => unknown)(p, opts);
    }) as typeof actual.readdirSync,
  };
});

vi.mock("../src/runtime-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime-paths.js")>();
  const path = await import("node:path");
  const os = await import("node:os");
  const home = path.join(os.tmpdir(), "tomo-test-people-registry-loads");
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

const GROUP_CHAT_ID = "-1002100";
const OWNER = { name: "owner", channels: { telegram: "12345" }, replyPolicy: "last-active" as const };

/** Senders arrive with their handles already bound — the steady state after
 *  everyone's first message, and the state the auto-binder is a no-op in. */
function seedRegistry(): void {
  mkdirSync(PUBLIC_PEOPLE_DIR, { recursive: true });
  writeFileSync(
    join(PUBLIC_PEOPLE_DIR, "alice.md"),
    "---\nname: Alice Example\naliases: ali\ntelegram: 6001\ntimezone: Asia/Tokyo\n---\n",
    "utf-8",
  );
  writeFileSync(
    join(PUBLIC_PEOPLE_DIR, "bob.md"),
    "---\nname: Bob Example\naliases: bobby\ntelegram: 6002\n---\n",
    "utf-8",
  );
}

describe("people registry reads on the inbound path", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    seedRegistry();
    counter.registryLoads = 0;
  });

  afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it("reads the registry exactly once for a single group message", async () => {
    resetConfig({ identities: [OWNER] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";

    const send = (text: string) => tg.simulateMessage(makeMsg({
      chatId: GROUP_CHAT_ID, text, isGroup: true, isMentioned: true, senderName: "ali", senderId: "6001",
    }));

    // Warm-up: creating the live session builds the system prompt, whose
    // participants block reads the registry once. That read is per SESSION,
    // not per message, and is not what this test is about.
    await send("@tomo hello");
    await drainQueue(agent);

    counter.registryLoads = 0;
    mockSdk.promptsBySession = [];
    await send("@tomo are you around?");
    await drainQueue(agent);

    expect(counter.registryLoads).toBe(1);

    // The work that single read had to cover: the sender annotation on the
    // prompt line and the sender's local clock on the stamp.
    const prompt = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompt).toContain("ali (Alice Example):");
    expect(prompt).toContain("· sender ");

    await agent.stop();
  });

  it("reads the registry exactly once for a coalesced batch", async () => {
    // Passive group: every message is seen without a mention, which is the
    // path that coalesces messages piled up behind an in-flight turn. Steering
    // off, so they queue and coalesce rather than being injected into the
    // running turn one at a time (each of those is its own message anyway).
    resetConfig({
      identities: [OWNER],
      passiveGroups: { telegram: [GROUP_CHAT_ID] },
      steering: false,
    });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);

    // Hold the first turn open so the next messages pile up behind it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstTurn = true;
    mockSdk.responseFn = async () => {
      if (firstTurn) {
        firstTurn = false;
        await gate;
      }
      return "ok";
    };

    const send = (text: string, senderName: string, senderId: string) => tg.simulateMessage(makeMsg({
      chatId: GROUP_CHAT_ID, text, isGroup: true, senderName, senderId,
    }));

    const first = send("one", "ali", "6001");
    await vi.waitFor(() => expect(firstTurn).toBe(false));
    await send("two", "bobby", "6002");
    await send("three", "ali", "6001");
    await send("four", "bobby", "6002");

    counter.registryLoads = 0;
    mockSdk.promptsBySession = [];
    release();
    await first;
    await drainQueue(agent);

    // Three messages, one turn, ONE read. Each item alone used to cost two
    // `formatGroupText` loads plus one for its time zone.
    expect(counter.registryLoads).toBe(1);

    // Fail loudly if this ever stops exercising the batch path — otherwise the
    // count above would be satisfied by three separate one-read turns.
    const prompt = mockSdk.promptsBySession.map((p) => p.text).join("\n");
    expect(prompt).toContain("messages arrived from this group in quick succession");
    expect(prompt).toContain("ali (Alice Example):");
    expect(prompt).toContain("bobby (Bob Example):");

    await agent.stop();
  });

  it("reads the registry once, not three times, for a private DM", async () => {
    // A DM has no sender annotation to make, but it does have to ask whether
    // the sender keeps a different clock — so one read is the honest floor,
    // and it is the whole cost. (`createPeopleSnapshot` itself reads nothing
    // until asked; see tests/people.test.ts.)
    resetConfig({ identities: [] });
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";

    await tg.simulateMessage(makeMsg({ chatId: "77777", text: "warm up" }));
    await drainQueue(agent);

    counter.registryLoads = 0;
    await tg.simulateMessage(makeMsg({ chatId: "77777", text: "hello" }));
    await drainQueue(agent);

    expect(counter.registryLoads).toBe(1);

    await agent.stop();
  });
});
