import { afterEach, describe, expect, it } from "vitest";
import { TOOL_PROGRESS_EVERY_MS, WebChannel } from "../src/channels/web.js";
import { WatchBus } from "../src/watch/bus.js";
import type { OwnerConfig } from "../src/owner.js";
import type { WebEvent } from "../src/web/protocol.js";
import type { SdkSignal } from "../src/agent/sdk-signals.js";

const owner: OwnerConfig = { name: "owner", telegram: ["test-owner"], imessage: [] };
const channels: WebChannel[] = [];
afterEach(async () => { for (const channel of channels.splice(0)) await channel.stop(); });

function setup(options: ConstructorParameters<typeof WebChannel>[2] = {}) {
  const bus = new WatchBus();
  const channel = new WebChannel(owner, bus, options);
  channels.push(channel);
  const events: WebEvent[] = [];
  channel.events.subscribe(({ event }) => events.push(event));
  const signal = (value: SdkSignal, sessionKey: string | null = "dm:owner") => bus.publish({ type: "sdk", ...(sessionKey ? { sessionKey } : {}), signal: value });
  return { channel, bus, events, signal, id: channel.ownerId! };
}

describe("SDK signals in the browser", () => {
  it("turn statuses reach the conversation they belong to, and a new turn clears them", () => {
    const { bus, events, signal, id } = setup();
    signal({ kind: "retry", attempt: 1, maxRetries: 10, delayMs: 2000, error: "overloaded", status: 529 });
    signal({ kind: "refusal", model: "claude-fable-5-1", fallbackModel: "claude-opus-5-5" });
    signal({ kind: "error", error: "billing_error" });
    signal({ kind: "stopped" });
    bus.publish({ type: "turn.start", sessionKey: "dm:owner", source: "user" });
    expect(events.filter((event) => event.type === "turn")).toEqual([
      { type: "turn", sessionId: id, status: { kind: "retry", attempt: 1, max: 10, delayMs: 2000, error: "overloaded" } },
      { type: "turn", sessionId: id, status: { kind: "refusal", model: "claude-fable-5-1", fallbackModel: "claude-opus-5-5" } },
      { type: "turn", sessionId: id, status: { kind: "error", error: "billing_error" } },
      { type: "turn", sessionId: id, status: { kind: "stopped" } },
      { type: "turn", sessionId: id, status: null },
    ]);
  });

  it("a session the browser cannot see gets nothing", () => {
    const { events, signal } = setup();
    signal({ kind: "error", error: "overloaded" }, "telegram:12345");
    signal({ kind: "error", error: "overloaded" }, null);
    expect(events).toEqual([]);
  });

  it("tool progress is sent at the first report and then at most every ten seconds per call", () => {
    let now = 1_000;
    const { events, signal } = setup({ now: () => now });
    const progress = (elapsedSeconds: number, toolUseId = "t1") => signal({ kind: "tool_progress", toolUseId, tool: "Bash", elapsedSeconds });
    progress(1); now += 2_000; progress(3); now += 2_000; progress(5, "t2");
    now += TOOL_PROGRESS_EVERY_MS; progress(15);
    expect(events.map((event) => event.type === "turn" && event.status?.kind === "tool" ? event.status.elapsed : null)).toEqual([1, 5, 15]);
  });

  it("the rate-limit state is the account's: sent on change only, and kept for a page that loads later", () => {
    let now = 5_000;
    const { channel, events, signal } = setup({ now: () => now });
    const warning: SdkSignal = { kind: "rate_limit", status: "allowed_warning", limit: "five_hour", resetsAt: 9_000_000, utilization: 90 };
    signal(warning, "telegram:-100"); now += 1; signal(warning); signal({ ...warning, status: "rejected" });
    expect(events).toEqual([
      { type: "rate-limit", limit: { status: "allowed_warning", limit: "five_hour", resetsAt: 9_000_000, utilization: 90, at: 5_000 } },
      { type: "rate-limit", limit: { status: "rejected", limit: "five_hour", resetsAt: 9_000_000, utilization: 90, at: 5_001 } },
    ]);
    expect(channel.snapshot().rateLimit).toMatchObject({ status: "rejected" });
  });

  it("the model badge follows the SDK's report, and a /model change replaces it until the SDK reports again", () => {
    let configured = "claude-opus-5-5";
    const { channel, events, signal, id } = setup({ model: () => configured });
    expect(channel.snapshot().models).toEqual({ [id]: "claude-opus-5-5" });
    signal({ kind: "model", model: "claude-opus-5-5[1m]" });
    // The same configured model does not flip the badge back to its other spelling.
    expect(channel.snapshot().models).toEqual({ [id]: "claude-opus-5-5[1m]" });
    configured = "claude-fable-5-1[1m]";
    expect(channel.snapshot().models).toEqual({ [id]: "claude-fable-5-1[1m]" });
    expect(events.filter((event) => event.type === "model").map((event) => event.type === "model" && event.model))
      .toEqual(["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-fable-5-1[1m]"]);
  });

  it("a snapshot survives a model reader that throws", () => {
    const { channel } = setup({ model: () => { throw new Error("no agent"); } });
    expect(channel.snapshot().models).toBeUndefined();
  });

  it("a suggestion stands until the next turn starts", () => {
    const { channel, bus, events, signal, id } = setup();
    signal({ kind: "suggestion", text: "and tomorrow?" });
    signal({ kind: "suggestion", text: "and tomorrow?" });
    expect(channel.snapshot().suggestions).toEqual({ [id]: "and tomorrow?" });
    bus.publish({ type: "turn.start", sessionKey: "dm:owner", source: "user" });
    expect(channel.snapshot().suggestions).toBeUndefined();
    expect(events.filter((event) => event.type === "suggestion")).toEqual([
      { type: "suggestion", sessionId: id, text: "and tomorrow?" }, { type: "suggestion", sessionId: id, text: null }]);
  });
});

describe("Stop from the browser", () => {
  it("stops the owner conversation's turn and reports whether one was running", async () => {
    const keys: string[] = [];
    let running = true;
    const { channel } = setup({ stop: async (key) => { keys.push(key); return running; } });
    await expect(channel.stopOwnerTurn()).resolves.toEqual({ stopped: true });
    running = false;
    await expect(channel.stopOwnerTurn()).resolves.toEqual({ stopped: false });
    expect(keys).toEqual(["dm:owner", "dm:owner"]);
  });

  it("is refused without an owner or a stop hook, and a failing hook reads as nothing stopped", async () => {
    await expect(setup().channel.stopOwnerTurn()).rejects.toMatchObject({ status: 409, code: "owner_setup_required" });
    await expect(setup({ stop: async () => { throw new Error("gone"); } }).channel.stopOwnerTurn()).resolves.toEqual({ stopped: false });
  });
});
