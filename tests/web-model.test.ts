import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

vi.mock("../src/config.js", async () => (await import("./helpers/agent-mocks.js")).configModuleMock());
vi.mock("../src/workspace/index.js", async () => (await import("./helpers/agent-mocks.js")).workspaceModuleMock());
vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./helpers/agent-mocks.js")).sdkModuleMock());
vi.mock("../src/logger.js", async () => (await import("./helpers/agent-mocks.js")).loggerModuleMock());

import { Agent, MockChannel, agentEnv, drainQueue, installAgentTestHooks, makeMsg, mockConfig, resetConfig } from "./helpers/agent-harness.js";
import { describeSessionModel, modelChoices } from "../src/agent/model-switch.js";
import { WebChannel, type WebModelAccess } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import { webSessionId } from "../src/web/owner.js";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { SessionStore } from "../src/sessions/store.js";
import type { WebBootstrap, WebEvent, WebModelView } from "../src/web/protocol.js";
import { effortText, modelErrorText, pickTarget, switchCopy } from "../web/src/model-picker.js";
import { sdkOptions } from "../src/agent/sdk-options.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

installAgentTestHooks();

const OWNER = { identities: [{ name: "owner", channels: { telegram: "12345" }, replyPolicy: "last-active" as const }] };
const savedOverrides = () => (JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")) as { sessionModelOverrides?: Record<string, string> }).sessionModelOverrides;
type Internals = { liveSessionManager: { isAlive(key: string): boolean; dispatches: Map<string, Set<{ interrupted: boolean }>> } };

describe("model switch from the web (agent side)", () => {
  it("uses the same switch as /model: persists, keeps the SDK session, restarts the live session", async () => {
    resetConfig(OWNER);
    const agent = new Agent();
    const tg = new MockChannel("telegram");
    agent.addChannel(tg);
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-haiku-4-5" }) + "\n");
    await tg.simulateMessage(makeMsg({ chatId: "12345", text: "Hi" }));
    await drainQueue(agent);
    const internals = agent as unknown as Internals;
    expect(internals.liveSessionManager.isAlive("dm:owner")).toBe(true);

    const before = agent.webModelView("dm:owner");
    expect(before).toMatchObject({ model: { id: mockConfig.model }, overridden: false, busy: false, gateway: { configured: false } });
    const outcome = agent.switchModelFromWeb("dm:owner", "sonnet", before.model.id);
    expect(outcome).toEqual({ ok: true, model: "claude-sonnet-5-5", previous: mockConfig.model, changed: true });
    expect(savedOverrides()?.["dm:owner"]).toBe("claude-sonnet-5-5");
    expect(internals.liveSessionManager.isAlive("dm:owner")).toBe(false);
    expect((agent as unknown as { sessions: SessionStore }).sessions.getSdkSessionId("dm:owner")).toBe("mock-sdk-session-123");
    expect(agent.webModelView("dm:owner")).toMatchObject({ model: { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (fast)" }, overridden: true });

    // The chat command reads the same override.
    await tg.simulateCommand("model", "12345", "TestUser", undefined, "12345");
    expect(tg.sent.at(-1)?.text).toContain("🧠 Current: claude-sonnet-5-5");
    await agent.stop();
  });

  it("refuses while a turn is in flight, for a stale review, and for unknown or unroutable models — writing nothing", async () => {
    resetConfig(OWNER);
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    writeFileSync(agentEnv.configFilePath, "{}\n");
    const current = mockConfig.model;
    const dispatches = (agent as unknown as Internals).liveSessionManager.dispatches;
    dispatches.set("dm:owner", new Set([{ interrupted: false }]));
    expect(agent.webModelView("dm:owner").busy).toBe(true);
    expect(agent.switchModelFromWeb("dm:owner", "haiku", current)).toMatchObject({ ok: false, reason: "turn_in_flight" });
    dispatches.delete("dm:owner");
    expect(agent.switchModelFromWeb("dm:owner", "haiku", "claude-opus-4-8")).toMatchObject({ ok: false, reason: "model_changed" });
    expect(agent.switchModelFromWeb("dm:owner", "not a model", current)).toEqual({ ok: false, reason: "unknown_model" });
    expect(agent.switchModelFromWeb("dm:owner", "chatgpt/gpt-5.5", current)).toMatchObject({ ok: false, reason: "gateway_required" });
    mockConfig.litellm = { mode: "chatgpt-subscription", baseUrl: "http://localhost:4000", apiKey: "sk-test" };
    expect(agent.switchModelFromWeb("dm:owner", "openrouter/x/y", current)).toMatchObject({ ok: false, reason: "gateway_unroutable" });
    expect(savedOverrides()).toBeUndefined();
    expect(mockConfig.sessionModelOverrides["dm:owner"]).toBeUndefined();
    // Choosing the model already in use changes nothing.
    expect(agent.switchModelFromWeb("dm:owner", current, current)).toMatchObject({ ok: true, changed: false });
    expect(savedOverrides()).toBeUndefined();
    await agent.stop();
  });

  it("reports a failed write as persist_failed and leaves the override alone", async () => {
    resetConfig(OWNER);
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    writeFileSync(agentEnv.configFilePath, "{ not json\n");
    expect(agent.switchModelFromWeb("dm:owner", "haiku", mockConfig.model)).toMatchObject({ ok: false, reason: "persist_failed" });
    expect(agent.webModelView("dm:owner").overridden).toBe(false);
    await agent.stop();
  });

  it("treats an older config's [1m]-tagged id as the untagged model, without rewriting the config", async () => {
    resetConfig({ ...OWNER, model: "claude-opus-5-5[1m]" });
    const agent = new Agent();
    agent.addChannel(new MockChannel("telegram"));
    writeFileSync(agentEnv.configFilePath, JSON.stringify({ model: "claude-opus-5-5[1m]" }) + "\n");
    const view = agent.webModelView("dm:owner");
    expect(view.model).toEqual({ id: "claude-opus-5-5", label: "Opus 5.5 (default)" });
    expect(view.defaultModel.id).toBe("claude-opus-5-5");
    expect(view.options.some((o) => o.id === view.model.id)).toBe(true);
    // The page reviewed the untagged id: choosing Opus is the model in use, nothing written.
    expect(agent.switchModelFromWeb("dm:owner", "opus", view.model.id)).toMatchObject({ ok: true, changed: false });
    expect(agent.switchModelFromWeb("dm:owner", "sonnet", view.model.id)).toMatchObject({ ok: true, model: "claude-sonnet-5-5", changed: true });
    expect(JSON.parse(readFileSync(agentEnv.configFilePath, "utf-8")).model).toBe("claude-opus-5-5[1m]");
    // The SDK is handed the untagged id.
    const server = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;
    expect(sdkOptions(server, undefined, undefined, { sessionKey: "dm:other" }).model).toBe("claude-opus-5-5");
    await agent.stop();
  });

  it("hands the SDK tomo's id for a stored alias, and marks it current", () => {
    resetConfig({ ...OWNER, model: "opus-1m", sessionModelOverrides: { "dm:owner": "fable" } });
    const server = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;
    expect(sdkOptions(server, undefined, undefined, { sessionKey: "dm:other" }).model).toBe("claude-opus-5-5");
    expect(sdkOptions(server, undefined, "fable", { sessionKey: "dm:owner" }).model).toBe("claude-fable-5-2");
    const view = describeSessionModel(new Map([["dm:owner", "fable"]]), "dm:owner", false);
    expect(view.model.id).toBe("claude-fable-5-2");
    expect(view.defaultModel.id).toBe("claude-opus-5-5");
  });

  it("lists each alias target once, with its aliases", () => {
    const choices = modelChoices();
    expect(choices.map((c) => c.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]);
    expect(choices[0]).toEqual({ id: "claude-opus-5-5", label: "Opus 5.5 (default)", aliases: ["opus", "opus-1m"] });
  });
});

const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
const GROUP = "telegram:-100777";

function fakeModels(overrides = new Map<string, string>()) {
  const switched: Array<[string, string, string]> = [];
  const access: WebModelAccess = {
    view: (key) => describeSessionModel(overrides, key, false),
    switch: (key, model, from) => {
      switched.push([key, model, from]);
      if (model === "bad") return { ok: false, reason: "unknown_model" };
      if (model === "busy") return { ok: false, reason: "turn_in_flight", model };
      const previous = overrides.get(key) ?? mockConfig.model;
      overrides.set(key, model);
      return { ok: true, model, previous, changed: previous !== model };
    },
  };
  return { access, switched };
}

describe("model switch from the web (channel)", () => {
  const channels: WebChannel[] = [];
  afterEach(async () => { for (const c of channels.splice(0)) await c.stop(); });

  it("reads the owner conversation and groups, switches only the owner's, and invalidates open pages", () => {
    resetConfig({});
    const { access, switched } = fakeModels();
    const channel = new WebChannel(owner, new WatchBus(), { models: access, ownerKey: () => "dm:owner", sessionKeys: () => ["dm:owner", GROUP, "dm:someone"] });
    channels.push(channel);
    const events: WebEvent[] = [];
    channel.events.subscribe(({ event }) => events.push(event));
    const ownerId = channel.ownerId!;
    expect(channel.model(ownerId)).toMatchObject({ sessionId: ownerId, writable: true, model: { id: mockConfig.model } });
    expect(channel.model(webSessionId(GROUP))).toMatchObject({ writable: false });
    expect(() => channel.model(webSessionId("dm:someone"))).toThrow(expect.objectContaining({ status: 404, code: "session_not_found" }));
    expect(() => channel.switchModel(webSessionId(GROUP), "haiku", mockConfig.model)).toThrow(expect.objectContaining({ status: 403, code: "owner_dm_only" }));
    expect(() => channel.switchModel(ownerId, "bad", mockConfig.model)).toThrow(expect.objectContaining({ status: 422, code: "unknown_model" }));
    expect(() => channel.switchModel(ownerId, "busy", mockConfig.model)).toThrow(expect.objectContaining({ status: 409, code: "turn_in_flight" }));
    expect(events).toEqual([]);
    expect(channel.switchModel(ownerId, "claude-haiku-5-5", mockConfig.model)).toEqual({ status: "switched",
      model: { id: "claude-haiku-5-5", label: "Haiku 5.5 (cheapest)" }, previous: { id: mockConfig.model, label: expect.any(String) } });
    expect(events).toEqual([{ type: "invalidate", sessionId: ownerId }]);
    expect(channel.switchModel(ownerId, "claude-haiku-5-5", "claude-haiku-5-5").status).toBe("unchanged");
    expect(events).toHaveLength(1);
    expect(switched.map(([key]) => key)).toEqual(["dm:owner", "dm:owner", "dm:owner", "dm:owner"]);
  });
});

describe("model switch over HTTP", () => {
  let root: string;
  let service: Awaited<ReturnType<typeof startWebHttp>>;
  let channel: WebChannel;
  let cookie = "";
  let boot: WebBootstrap;
  let base: string;
  let switched: Array<[string, string, string]>;
  const token = "tomo_web_" + "e".repeat(64);
  const get = (p: string) => fetch(base + "/api/v1" + p, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie } });
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + "/api/v1/models", { method: "POST", body: JSON.stringify(body), headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie,
      origin: base, "content-type": "application/json", "x-tomo-csrf": boot.csrfToken, "x-tomo-epoch": boot.epoch, ...headers } });
    return { status: response.status, value: await response.json() as Record<string, unknown> };
  };
  beforeEach(async () => {
    resetConfig({});
    cookie = "";
    root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-model-")));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
    const store = new SessionStore(sessionsDir, 20, sdkSessionsDir);
    store.touchSession("dm:owner"); store.touchSession(GROUP);
    const models = fakeModels();
    switched = models.switched;
    channel = new WebChannel(owner, new WatchBus(), { models: models.access, ownerKey: () => "dm:owner", sessionKeys: () => ["dm:owner", GROUP] });
    channel.onMessage(async () => true);
    service = await startWebHttp(0, { accessToken: token, assetsDir: root,
      data: new WebData({ cronDbPath: join(root, "jobs.json"), sessionsDir, sdkSessionsDir, owner }),
      subscribe: (fn) => channel.events.subscribe(fn), rpc: async (rpc) => {
        if (rpc.method === "snapshot") return { snapshot: channel.snapshot(), replay: null };
        if (rpc.method === "epoch") return channel.events.epoch;
        if (rpc.method === "model") return channel.model(rpc.sessionId);
        if (rpc.method === "model-switch") return channel.switchModel(rpc.sessionId, rpc.model, rpc.from);
        throw new Error("unexpected rpc");
      } });
    base = `http://127.0.0.1:${service.port}`;
    const response = await fetch(`${base}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
    cookie = response.headers.getSetCookie()[0].split(";")[0];
    boot = await response.json() as WebBootstrap;
  });
  afterEach(async () => { await service?.close(); await channel?.stop(); rmSync(root, { recursive: true, force: true }); });

  it("reads the model of a conversation the browser can see", async () => {
    const view = await (await get(`/models?session=${boot.ownerId}`)).json() as WebModelView;
    expect(view).toMatchObject({ sessionId: boot.ownerId, writable: true, model: { id: mockConfig.model }, options: expect.any(Array) });
    expect(await (await get(`/models?session=${webSessionId(GROUP)}`)).json()).toMatchObject({ writable: false });
    expect((await get("/models?session=nope")).status).toBe(400);
    expect((await get(`/models?session=${webSessionId("dm:other")}`)).status).toBe(404);
  });

  it("requires origin, CSRF, JSON, the current epoch, confirm: true and the owner's conversation", async () => {
    const body = { sessionId: boot.ownerId, model: "haiku", from: mockConfig.model, confirm: true };
    expect((await post(body, { origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await post(body, { "x-tomo-csrf": "bad" })).value).toEqual({ error: "invalid_csrf" });
    expect((await post(body, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(body, { "x-tomo-epoch": randomUUID() })).value).toEqual({ error: "epoch_changed" });
    expect((await post({ ...body, confirm: undefined })).value).toEqual({ error: "invalid_model_change" });
    expect((await post({ ...body, extra: 1 })).status).toBe(400);
    expect(await post({ ...body, sessionId: webSessionId(GROUP) })).toEqual({ status: 403, value: { error: "owner_dm_only" } });
    expect(switched).toEqual([]);
  });

  it("switches, and names a refusal", async () => {
    expect(await post({ sessionId: boot.ownerId, model: "bad", from: mockConfig.model, confirm: true })).toEqual({ status: 422, value: { error: "unknown_model" } });
    expect(await post({ sessionId: boot.ownerId, model: "busy", from: mockConfig.model, confirm: true })).toEqual({ status: 409, value: { error: "turn_in_flight" } });
    const ok = await post({ sessionId: boot.ownerId, model: "claude-haiku-5-5", from: mockConfig.model, confirm: true });
    expect(ok).toMatchObject({ status: 200, value: { status: "switched", model: { id: "claude-haiku-5-5" } } });
    expect(switched.at(-1)).toEqual(["dm:owner", "claude-haiku-5-5", mockConfig.model]);
  });
});

describe("Model page copy", () => {
  it("names both models in the confirm, resolves listed aliases, and words refusals", () => {
    const view = { options: modelChoices() };
    expect(pickTarget(view, " Sonnet ")).toEqual({ id: "claude-sonnet-5-5", label: "Sonnet 5.5 (fast)" });
    expect(pickTarget(view, "claude-opus-4-8")).toEqual({ id: "claude-opus-4-8", label: "claude-opus-4-8" });
    expect(pickTarget(view, "  ")).toBeNull();
    const copy = switchCopy({ id: "a", label: "Opus 5.5" }, { id: "b", label: "Haiku 5.5" });
    expect(copy.title).toBe("Switch to Haiku 5.5?");
    expect(copy.body).toContain("from Opus 5.5 to Haiku 5.5");
    expect(copy.body).toContain("from the next message");
    expect(modelErrorText("turn_in_flight", "Tomo")).toContain("Tomo is in the middle of a reply");
    expect(modelErrorText("something_else", "Tomo")).toContain("could not be confirmed");
  });
});

describe("Model page effort", () => {
  const server = { type: "sdk", name: "tomo-internal", instance: {} } as unknown as McpSdkServerConfigWithInstance;
  const sent = (key: string, model?: string) => sdkOptions(server, undefined, model, { sessionKey: key }).effort ?? null;

  it("shows the level each session starts with and where it comes from, as sdkOptions sends it", () => {
    const LEGACY = "imessage:any;+;chat0000000001";
    resetConfig({ effort: "high", sessionEffortOverrides: { [LEGACY]: "low" } });
    const overrides = new Map<string, string>([["dm:gateway", "chatgpt/gpt-5.5"]]);
    const cases: Array<[string, WebModelView["effort"]]> = [
      [LEGACY, { level: "low", source: "session" }],
      ["dm:owner", { level: "high", source: "global" }],
      ["dm:gateway", { level: null, source: "not-supported" }],
    ];
    for (const [key, expected] of cases) {
      const view = describeSessionModel(overrides, key, false);
      expect(view.effort).toEqual(expected);
      expect(sent(key, overrides.get(key))).toBe(view.effort.level);
    }
    resetConfig({ effort: null });
    expect(describeSessionModel(new Map(), "dm:owner", false).effort).toEqual({ level: null, source: "sdk-default" });
    expect(sent("dm:owner")).toBeNull();
  });

  it("words each source", () => {
    expect(effortText({ level: "low", source: "session" })).toContain("chosen for this conversation");
    expect(effortText({ level: "high", source: "global" })).toBe("high, the default from config.json.");
    expect(effortText({ level: null, source: "sdk-default" })).toContain("model's own default");
    expect(effortText({ level: null, source: "not-supported" })).toContain("does not take an effort");
  });
});
