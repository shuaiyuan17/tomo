import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import {
  Agent,
  MockChannel,
  SessionStore,
  agentEnv,
  drainQueue,
  installAgentTestHooks,
  makeMsg,
  mockConfig,
  mockSdk,
  resetConfig,
  useRealAdmission,
} from "./helpers/agent-harness.js";
import { OwnerRouter } from "../src/router.js";
import { CronStore } from "../src/cron/store.js";
import { precreateOwnerSessionUnlessAdoptable } from "../src/cli/init-setup.js";
import { SummonStore } from "../src/sessions/summon-store.js";
import { normalizeSendTarget } from "../src/agent/send-target.js";
import { webSessionId } from "../src/web/owner.js";
import { WebData } from "../src/web/data.js";
import type { SessionEntry } from "../src/sessions/types.js";

installAgentTestHooks();

// ---------------------------------------------------------------------------
// GOLDEN: an upgraded single-identity install keeps its exact session.
//
// The fixture mirrors the shape of a long-running install (names and handles
// are placeholders): ONE identity, capitalised, bound to Telegram and
// iMessage, both channels allowlisted (owner + groups), a model override on
// the dm: key, a linked dm: session with history, cron jobs and a summon on
// that key, and a stale raw per-channel iMessage session left over from
// before the identity existed. Nothing under the data dir may be renamed or
// moved, and no second owner session may appear.
// ---------------------------------------------------------------------------

const TG_ID = "123456789";
const HANDLE = "+15555550123";
const DM_GUID = `any;-;${HANDLE}`;
const STALE_RAW = `imessage:${DM_GUID}`;
const GROUP = "any;+;chat0000000001";
const OWNER_KEY = "dm:alex";
// The mock SDK reports this id for every result, like a real resume does
// for the session it resumed.
const SDK_ID = "mock-sdk-session-123";

const LIVE_SHAPE_CONFIG = {
  channels: {
    telegram: { token: "test-token", allowlist: [TG_ID] },
    imessage: { provider: "imsg", allowlist: [HANDLE, GROUP, "any;+;chat0000000002"] },
  },
  identities: [{ name: "Alex", channels: { telegram: TG_ID, imessage: HANDLE }, replyPolicy: "last-active" }],
  sessionModelOverrides: { [OWNER_KEY]: "claude-opus-5[1m]" },
};

function useLiveShape(): void {
  resetConfig({
    identities: LIVE_SHAPE_CONFIG.identities,
    channelAllowlists: {
      telegram: LIVE_SHAPE_CONFIG.channels.telegram.allowlist,
      imessage: LIVE_SHAPE_CONFIG.channels.imessage.allowlist,
    },
    sessionModelOverrides: { ...LIVE_SHAPE_CONFIG.sessionModelOverrides },
    groupSecret: "tomo-secret-golden",
  });
}

/** Lay down the persisted state of the upgraded install. */
function seedDataDir(): void {
  writeFileSync(agentEnv.configFilePath, JSON.stringify(LIVE_SHAPE_CONFIG, null, 2) + "\n");
  const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
  // The stale raw owner-iMessage session first, so it sits ahead of dm:alex
  // in registry order (the order findFirstDmSession-style lookups walked).
  store.setSdkSessionId(STALE_RAW, "sdk-stale-raw");
  store.append(STALE_RAW, { role: "user", content: "old raw imessage history", timestamp: 1, channel: "imessage" });
  store.setSdkSessionId(OWNER_KEY, SDK_ID);
  store.setReplyTarget(OWNER_KEY, { channelName: "telegram", chatId: TG_ID });
  store.append(OWNER_KEY, { role: "user", content: "earlier owner history", timestamp: 2, channel: "telegram" });
  store.setSdkSessionId(`imessage:${GROUP}`, "sdk-group-1");
  store.setChatTitle(`imessage:${GROUP}`, "Group One");

  const data = join(mockConfig.tomoHome, "data");
  mkdirSync(join(data, "cron"), { recursive: true });
  writeFileSync(join(data, "cron", "jobs.json"), JSON.stringify({
    version: 1,
    revision: 7,
    jobs: [
      { id: "job-1", name: "daily", sessionKey: OWNER_KEY, schedule: { kind: "cron", expr: "0 9 * * *" }, prompt: "p", enabled: true },
      { id: "job-2", name: "weekly", sessionKey: OWNER_KEY, schedule: { kind: "cron", expr: "0 9 * * 1" }, prompt: "p", enabled: true },
    ],
  }, null, 2));
  mkdirSync(join(data, "lcm"), { recursive: true });
  writeFileSync(join(data, "lcm", "nudge-cooldown.json"), JSON.stringify({ [`${OWNER_KEY}:daily:2026-10-01`]: 1 }));
  // A summon persisted before the upgrade: stores the lowercased name.
  new SummonStore(join(data, "summons.json"), 0).set(`imessage:${GROUP}`, "alex");
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

function registry(): SessionEntry[] {
  return (JSON.parse(readFileSync(join(mockConfig.sessionsDir, "_sessions.json"), "utf-8")) as { sessions: SessionEntry[] }).sessions;
}

/** Registry entries with the fields a message is ALLOWED to touch removed. */
function stableRegistryView(entries: SessionEntry[]): unknown[] {
  return entries.map((e) => {
    const copy: Record<string, unknown> = { ...e };
    delete copy.lastActiveAt;
    delete copy.replyTarget;
    delete copy.stats;
    delete copy.usageBaseline;
    return copy;
  });
}

describe("golden: upgrading a single-identity install to `owner`", () => {
  it("every channel, the web UI, a persisted summon and send_message all resolve to the SAME dm:<name> session", async () => {
    useRealAdmission();
    useLiveShape();
    seedDataDir();

    expect(mockConfig.owner).toEqual({ name: "Alex", telegram: [TG_ID], imessage: [HANDLE] });
    const router = new OwnerRouter(mockConfig.owner, new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir), mockConfig.channelAllowlists,
      new SummonStore(join(mockConfig.tomoHome, "data", "summons.json"), 0));

    expect(router.ownerSessionKey()).toBe(OWNER_KEY);
    expect(router.resolve("telegram", TG_ID, false).sessionKey).toBe(OWNER_KEY);
    for (const guid of [DM_GUID, `iMessage;-;${HANDLE}`, `SMS;-;${HANDLE}`]) {
      expect(router.resolve("imessage", guid, false).sessionKey).toBe(OWNER_KEY);
    }
    expect(router.resolve("web", "owner", false).sessionKey).toBe(OWNER_KEY);
    expect(router.resolve("imessage", GROUP, true).sessionKey).toBe(OWNER_KEY);
    expect(normalizeSendTarget("Alex", mockConfig.owner)?.sessionKey).toBe(OWNER_KEY);
    expect(normalizeSendTarget("owner", mockConfig.owner)?.sessionKey).toBe(OWNER_KEY);
    expect(normalizeSendTarget(`telegram:${TG_ID}`, mockConfig.owner)?.sessionKey).toBe(OWNER_KEY);
    expect(new WebData({ sessionsDir: mockConfig.sessionsDir, sdkSessionsDir: mockConfig.sdkSessionsDir, owner: mockConfig.owner })
      .catalog().ownerId).toBe(webSessionId(OWNER_KEY));

    // The stale raw entry is not adopted (the owner key already has a session).
    expect(registry().filter((e) => e.unlinkedAt === null).map((e) => [e.channelKey, e.sdkSessionId])).toEqual([
      [STALE_RAW, "sdk-stale-raw"],
      [OWNER_KEY, SDK_ID],
      [`imessage:${GROUP}`, "sdk-group-1"],
    ]);
  });

  it("resolving an owner DM whose reply target is unchanged writes NO file; maybeMigrate does not fire", () => {
    useRealAdmission();
    useLiveShape();
    seedDataDir();
    const before = snapshot(agentEnv.tmpDir);

    const sessions = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    const router = new OwnerRouter(mockConfig.owner, sessions, mockConfig.channelAllowlists);
    expect(router.prepareOwnerSession()).toBe(OWNER_KEY);
    expect(router.resolve("telegram", TG_ID, false).sessionKey).toBe(OWNER_KEY);

    expect(snapshot(agentEnv.tmpDir)).toEqual(before);
  });

  it("daemon boot + one owner message on each channel: no file renamed, moved or rewritten beyond the allowed appends", async () => {
    useRealAdmission();
    useLiveShape();
    seedDataDir();
    const before = snapshot(agentEnv.tmpDir);
    const transcriptBefore = readFileSync(join(mockConfig.sessionsDir, "dm_alex.jsonl"), "utf-8");
    const registryBefore = registry();

    const agent = new Agent();
    agent.prepareOwner();
    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    const web = new MockChannel("web");
    agent.addChannel(tg);
    agent.addChannel(im);
    agent.addChannel(web);
    mockSdk.responseFn = () => "ok";

    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "from telegram" }));
    await drainQueue(agent);
    await im.simulateMessage(makeMsg({ chatId: DM_GUID, senderId: HANDLE, text: "from imessage" }));
    await drainQueue(agent);
    await web.simulateMessage(makeMsg({ chatId: "owner", senderName: "Owner", text: "from web" }));
    await drainQueue(agent);
    await agent.stop();

    // Every turn ran on the one owner session, with its model override.
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual([OWNER_KEY, OWNER_KEY, OWNER_KEY]);
    expect(mockSdk.optionsBySession.every((o) => o.options.model === "claude-opus-5[1m]")).toBe(true);
    expect(tg.delivered.map((d) => d.chatId)).toEqual([TG_ID]);
    expect(im.delivered.map((d) => d.chatId)).toEqual([DM_GUID]);

    const after = snapshot(agentEnv.tmpDir);
    // Nothing renamed or moved: every file is still where it was.
    for (const path of before.keys()) expect(after.has(path), path).toBe(true);
    const changed = [...before.keys()].filter((path) => before.get(path) !== after.get(path)).sort();
    expect(changed).toEqual(["sessions/_sessions.json", "sessions/dm_alex.jsonl"]);
    // The transcript only grew (append-only).
    expect(readFileSync(join(mockConfig.sessionsDir, "dm_alex.jsonl"), "utf-8").startsWith(transcriptBefore)).toBe(true);
    // The registry only changed in lastActiveAt / replyTarget / stats: same
    // entries, same keys, same SDK session ids, nothing migrated or added.
    expect(stableRegistryView(registry())).toEqual(stableRegistryView(registryBefore));
    // New files are only advisory lock files.
    const added = [...after.keys()].filter((path) => !before.has(path));
    expect(added.filter((path) => !path.endsWith(".lock"))).toEqual([]);
    // The cron store, summons, LCM latch and config are byte-identical.
    for (const path of ["data/cron/jobs.json", "data/summons.json", "data/lcm/nudge-cooldown.json", "config.json"]) {
      expect(after.get(path), path).toBe(before.get(path));
    }
  });

  it("with several identities, the others' sessions and transcripts stay byte-identical and their DMs are ignored", async () => {
    useRealAdmission();
    resetConfig({
      identities: [
        { name: "Alex", channels: { telegram: TG_ID }, replyPolicy: "last-active" },
        { name: "Sam", channels: { telegram: "222" }, replyPolicy: "telegram" },
      ],
    });
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.setSdkSessionId("dm:sam", "sdk-sam");
    store.setReplyTarget("dm:sam", { channelName: "telegram", chatId: "222" });
    store.append("dm:sam", { role: "user", content: "sam's history", timestamp: 1, channel: "telegram" });
    const samTranscript = createHash("sha256").update(readFileSync(join(mockConfig.sessionsDir, "dm_sam.jsonl"))).digest("hex");
    const samEntry = store.getEntry("dm:sam");

    const agent = new Agent();
    agent.prepareOwner();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";
    await tg.simulateMessage(makeMsg({ chatId: "222", senderId: "222", text: "hi from sam" }));
    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "hi from alex" }));
    await drainQueue(agent);
    await agent.stop();

    expect(tg.delivered.map((d) => d.chatId)).toEqual([TG_ID]);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:alex"]);
    expect(createHash("sha256").update(readFileSync(join(mockConfig.sessionsDir, "dm_sam.jsonl"))).digest("hex")).toBe(samTranscript);
    expect(registry().find((e) => e.channelKey === "dm:sam")).toEqual(samEntry);
  });
});

describe("the owner DM exists from the start and every channel binds to it", () => {
  it("first start pre-creates dm:<owner>; Telegram, iMessage and web then share it — no raw per-channel owner session", async () => {
    useRealAdmission();
    resetConfig({ identities: [{ name: "Alex", channels: { telegram: TG_ID, imessage: HANDLE }, replyPolicy: "last-active" }] });

    const agent = new Agent();
    agent.prepareOwner();
    expect(registry().map((e) => [e.channelKey, e.sdkSessionId])).toEqual([[OWNER_KEY, ""]]);

    const tg = new MockChannel("telegram");
    const im = new MockChannel("imessage");
    const web = new MockChannel("web");
    agent.addChannel(tg);
    agent.addChannel(im);
    agent.addChannel(web);
    mockSdk.responseFn = () => "ok";
    await im.simulateMessage(makeMsg({ chatId: `SMS;-;${HANDLE}`, senderId: HANDLE, text: "first ever message" }));
    await drainQueue(agent);
    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "second" }));
    await drainQueue(agent);
    await web.simulateMessage(makeMsg({ chatId: "owner", text: "third" }));
    await drainQueue(agent);
    await agent.stop();

    const active = registry().filter((e) => e.unlinkedAt === null);
    expect(active.map((e) => e.channelKey)).toEqual([OWNER_KEY]);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual([OWNER_KEY, OWNER_KEY, OWNER_KEY]);
    expect(existsSync(join(mockConfig.sessionsDir, "telegram_123456789.jsonl"))).toBe(false);
  });

  it("prepareOwner is idempotent and writes nothing once the entry exists", () => {
    resetConfig({ identities: [{ name: "Alex", channels: { telegram: TG_ID }, replyPolicy: "last-active" }] });
    const agent = new Agent();
    agent.prepareOwner();
    const before = snapshot(agentEnv.tmpDir);
    agent.prepareOwner();
    new Agent().prepareOwner();
    expect(snapshot(agentEnv.tmpDir)).toEqual(before);
  });

  it("a raw session is never merged into an owner key that already exists (even a pre-created stub)", async () => {
    useRealAdmission();
    resetConfig({ identities: [{ name: "Alex", channels: { telegram: TG_ID }, replyPolicy: "last-active" }] });
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.setSdkSessionId(`telegram:${TG_ID}`, "sdk-legacy");
    store.ensureEntry(OWNER_KEY);

    const agent = new Agent();
    agent.prepareOwner();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";
    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "hello" }));
    await drainQueue(agent);
    await agent.stop();

    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual([OWNER_KEY]);
    expect(mockSdk.optionsBySession[0].options.resume).toBeUndefined();
    const active = registry().filter((e) => e.unlinkedAt === null).map((e) => [e.channelKey, e.sdkSessionId]);
    expect(active).toEqual([[`telegram:${TG_ID}`, "sdk-legacy"], [OWNER_KEY, SDK_ID]]);
  });

  it("the store folds a metadata-only stub under the destination key instead of creating a second active entry", () => {
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.setSdkSessionId("telegram:1", "sdk-a");
    store.ensureEntry(OWNER_KEY);
    store.setReplyTarget(OWNER_KEY, { channelName: "telegram", chatId: "1" });
    store.migrateSessionKey("telegram:1", OWNER_KEY);
    const active = store.listAllSessions().filter((e) => e.unlinkedAt === null);
    expect(active.map((e) => [e.channelKey, e.sdkSessionId])).toEqual([[OWNER_KEY, "sdk-a"]]);
    expect(active[0].replyTarget).toEqual({ channelName: "telegram", chatId: "1" });
  });

  it("adoption refuses to re-key onto an owner key that already has a linked session", () => {
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.setSdkSessionId("telegram:1", "sdk-a");
    store.setSdkSessionId(OWNER_KEY, "sdk-b");
    expect(() => store.migrateSessionKey("telegram:1", OWNER_KEY)).toThrow(/already has a linked session/);
    expect(store.getSdkSessionId(OWNER_KEY)).toBe("sdk-b");
    expect(store.getSdkSessionId("telegram:1")).toBe("sdk-a");
  });
});

describe("adoption is one-time and carries the session's cron jobs and model override", () => {
  const RAW = `telegram:${TG_ID}`;
  const jobsPath = () => join(mockConfig.tomoHome, "data", "cron", "jobs.json");
  function seedPreIdentityInstall(): void {
    // A pre-July install adopted by rule 4: owner "owner" bound to the single
    // Telegram DM allowlist entry; its history, a cron job and a model
    // override all live on the raw key.
    resetConfig({
      owner: { name: "owner", telegram: [TG_ID], imessage: [] },
      channelAllowlists: { telegram: [TG_ID] },
      sessionModelOverrides: { [RAW]: "claude-opus-5[1m]" },
    });
    writeFileSync(agentEnv.configFilePath, JSON.stringify({
      channels: { telegram: { token: "t", allowlist: [TG_ID] } },
      sessionModelOverrides: { [RAW]: "claude-opus-5[1m]" },
    }, null, 2));
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.setSdkSessionId(RAW, SDK_ID);
    store.append(RAW, { role: "user", content: "pre-identity history", timestamp: 1, channel: "telegram" });
    mkdirSync(join(mockConfig.tomoHome, "data", "cron"), { recursive: true });
    const cron = new CronStore(jobsPath());
    cron.add({ name: "morning", schedule: { kind: "cron", expr: "0 9 * * *" }, message: "m", sessionKey: RAW });
    cron.add({ name: "group", schedule: { kind: "cron", expr: "0 9 * * *" }, message: "m", sessionKey: "telegram:-100555" });
  }
  const jobKeys = () => new CronStore(jobsPath()).list().map((j) => [j.name, j.sessionKey]);

  it("rule-4 adoption moves the cron jobs and the model override with the session (and only those)", async () => {
    useRealAdmission();
    seedPreIdentityInstall();
    const agent = new Agent();
    agent.prepareOwner();

    expect(registry().filter((e) => e.unlinkedAt === null).map((e) => [e.channelKey, e.sdkSessionId])).toEqual([["dm:owner", SDK_ID]]);
    expect(jobKeys()).toEqual([["morning", "dm:owner"], ["group", "telegram:-100555"]]);
    expect(mockConfig.sessionModelOverrides).toEqual({ "dm:owner": "claude-opus-5[1m]" });
    expect(JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")).sessionModelOverrides).toEqual({ "dm:owner": "claude-opus-5[1m]" });
    expect(existsSync(join(mockConfig.tomoHome, "data", "owner-adoption-pending.json"))).toBe(false);

    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";
    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "hi" }));
    await drainQueue(agent);
    await agent.handleCronMessage("morning", "dm:owner");
    await drainQueue(agent);
    await agent.stop();
    // Both the DM and the cron run resume the adopted session with its model.
    expect(mockSdk.optionsBySession.map((o) => [o.sessionKey, o.options.resume, o.options.model]))
      .toEqual([["dm:owner", SDK_ID, "claude-opus-5[1m]"]]);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:owner", "dm:owner"]);
  });

  it("an adoption interrupted after its re-key finishes the follow-ups on the next start (idempotent)", () => {
    seedPreIdentityInstall();
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.migrateSessionKey(RAW, "dm:owner");
    writeFileSync(join(mockConfig.tomoHome, "data", "owner-adoption-pending.json"), JSON.stringify({ version: 1, from: RAW, to: "dm:owner" }));
    new Agent().prepareOwner();
    expect(jobKeys()).toEqual([["morning", "dm:owner"], ["group", "telegram:-100555"]]);
    expect(mockConfig.sessionModelOverrides).toEqual({ "dm:owner": "claude-opus-5[1m]" });
    new Agent().prepareOwner();
    expect(jobKeys()).toEqual([["morning", "dm:owner"], ["group", "telegram:-100555"]]);
  });

  it("a cron-created raw session is never adopted after /new (repro: no dm:owner|SID-CRON-FORK)", async () => {
    useRealAdmission();
    seedPreIdentityInstall();
    const agent = new Agent();
    agent.prepareOwner();
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    store.clearSdkSessionId("dm:owner");           // /new
    store.setSdkSessionId(RAW, "SID-CRON-FORK");   // a session some cron run created on the raw key

    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";
    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "after /new" }));
    await drainQueue(agent);
    await agent.stop();

    expect(mockSdk.optionsBySession[0].options.resume).toBeUndefined();
    expect(new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).getSdkSessionId(RAW)).toBe("SID-CRON-FORK");
  });

  it("live shape: clearing the owner's session (/new, timeout) never resumes the stale raw iMessage session", async () => {
    useRealAdmission();
    useLiveShape();
    seedDataDir();
    new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir).clearSdkSessionId(OWNER_KEY);

    const agent = new Agent();
    agent.prepareOwner();
    const im = new MockChannel("imessage");
    agent.addChannel(im);
    mockSdk.responseFn = () => "ok";
    await im.simulateMessage(makeMsg({ chatId: DM_GUID, senderId: HANDLE, text: "hello" }));
    await drainQueue(agent);
    await agent.stop();

    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual([OWNER_KEY]);
    expect(mockSdk.optionsBySession[0].options.resume).toBeUndefined();
    const stale = registry().find((e) => e.channelKey === STALE_RAW && e.unlinkedAt === null);
    expect(stale?.sdkSessionId).toBe("sdk-stale-raw");
  });

  it("a cron job dispatched on the raw owner key runs on the owner session once a DM completed the adoption", async () => {
    seedPreIdentityInstall();
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    // Startup adoption deferred (registry briefly unreadable, say): the
    // scheduler still dispatches the job under the raw key...
    const store = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    // ...and an owner DM completes the adoption before the job executes.
    store.migrateSessionKey(RAW, "dm:owner");
    mockSdk.responseFn = () => "NO_REPLY";
    const ok = await agent.handleCronMessage("morning", RAW, { waitForHandoff: true, jobName: "morning" });
    await drainQueue(agent);
    await agent.stop();

    expect(ok).toBe(true);
    expect(mockSdk.promptsBySession.map((p) => p.sessionKey)).toEqual(["dm:owner"]);
    expect(mockSdk.optionsBySession[0].options.resume).toBe(SDK_ID);
    const after = new SessionStore(mockConfig.sessionsDir, 20, mockConfig.sdkSessionsDir);
    expect(after.getEntry(RAW)).toBeUndefined();   // no raw session recreated
  });

  it("while an adoption is still pending, a raw-key cron job keeps running on the raw (legacy) session", async () => {
    seedPreIdentityInstall();
    const agent = new Agent();   // prepareOwner not run: nothing adopted yet
    agent.addChannel(new MockChannel("telegram"));
    mockSdk.responseFn = () => "NO_REPLY";
    await agent.handleCronMessage("morning", RAW, { waitForHandoff: true });
    await drainQueue(agent);
    await agent.stop();
    expect(mockSdk.optionsBySession.map((o) => [o.sessionKey, o.options.resume])).toEqual([[RAW, SDK_ID]]);
  });

  it("tomo init on a pre-identity install does not strand the history: the first start still adopts it", async () => {
    useRealAdmission();
    seedPreIdentityInstall();
    // What `tomo init --force` now does for the owner session…
    expect(precreateOwnerSessionUnlessAdoptable({ name: "owner", telegram: [TG_ID], imessage: [] }, mockConfig.sessionsDir, mockConfig.sdkSessionsDir))
      .toBe("deferred-to-adoption");
    // …so the daemon's first start adopts the raw session with its cron job and model.
    const agent = new Agent();
    agent.prepareOwner();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    mockSdk.responseFn = () => "ok";
    await tg.simulateMessage(makeMsg({ chatId: TG_ID, senderId: TG_ID, text: "hi again" }));
    await drainQueue(agent);
    await agent.stop();
    expect(mockSdk.optionsBySession.map((o) => [o.sessionKey, o.options.resume])).toEqual([["dm:owner", SDK_ID]]);
    expect(jobKeys()).toContainEqual(["morning", "dm:owner"]);
  });
});

