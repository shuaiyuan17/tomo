import { afterEach, describe, it, expect, vi } from "vitest";
import type { ImsgCapabilities, ImsgChannelConfig } from "../src/channels/imessage-imsg.js";
import { isNothingSent, partsSent, type ChannelFaultNotice } from "../src/channels/types.js";
import { log } from "../src/logger.js";
import {
  type RpcRequest,
  FakeChild,
  type Responder,
  CAPS_FULL,
  makeChannel,
  mutationChildOf,
  DM_GUID,
  inboundMessage,
  settle,
  defaultResponder,
  leavingPending,
  sentTexts,
  waitFor,
} from "./helpers/fake-imsg.js";

// ImsgChannel tests, split by concern (fakes in tests/helpers/fake-imsg.ts).
// JSON-RPC transport to the `imsg rpc` child: framing, child lifecycle and
// restarts (incl. -32004 mutation-lane recovery), stdin backpressure, and
// cleanup after a failed subscribe.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- RPC framing -----------------------------------------------------------

describe("imsg RPC framing", () => {
  it("writes each request as one newline-terminated JSON-RPC 2.0 line", async () => {
    const { channel, children } = makeChannel();
    await channel.start();

    const line = children[0].stdin.lines[0];
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    const req = JSON.parse(line) as RpcRequest;
    expect(req.jsonrpc).toBe("2.0");
    expect(typeof req.id).toBe("number");
    expect(req.method).toBe("watch.subscribe");
    expect(req.params).toMatchObject({ attachments: true, include_reactions: true });

    await channel.stop();
  });

  it("routes responses to their request by id and surfaces RPC errors", async () => {
    const { channel, requests } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 7 });
        if (req.method === "send") return child.respondError(req.id, -32603, "Internal error", "boom");
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await expect(channel.send({ chatId: DM_GUID, text: "hi" })).rejects.toThrow(/send failed.*Internal error.*boom/);
    expect(requests().filter((r) => r.method === "send")).toHaveLength(1);

    await channel.stop();
  });

  // P0-5: only a send that put NOTHING on the wire may be re-sent whole.
  it("marks an RPC refusal of the first chunk nothing-sent, and of a later chunk partly-sent", async () => {
    let sends = 0;
    let failOn = 0;
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 7 });
        if (req.method === "send") {
          if (sends++ === failOn) return child.respondError(req.id, -32603, "Internal error", "refused");
          return child.respond(req.id, { ok: true });
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const first = await channel.send({ chatId: DM_GUID, text: "hi" }).then(() => null, (e: unknown) => e);
    expect(isNothingSent(first)).toBe(true);

    sends = 0;
    failOn = 1;
    const later = await channel.send({ chatId: DM_GUID, text: "word ".repeat(1_700) }).then(() => null, (e: unknown) => e);
    expect(later).not.toBeNull();
    expect(isNothingSent(later)).toBe(false);
    expect(partsSent(later)).toEqual({ sent: 1, total: 3 });

    await channel.stop();
  });

  it("serializes a structured RPC error `data` instead of logging [object Object]", async () => {
    const data = { lane: "send", reason: "a previous mutation is still running", retryAfterMs: 250 };
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 7 });
        if (req.method === "send") return child.respondError(req.id, -32004, "Mutation lane blocked", data);
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const err = await channel.send({ chatId: DM_GUID, text: "hi" }).then(() => null, (e: unknown) => e as Error & { rpcCode?: number; rpcData?: unknown });
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("[object Object]");
    // The structured payload stays out of the message (which can be shown)
    // and travels as a field the log serializer writes.
    expect(err!.message).toBe("imsg rpc send failed (-32004) Mutation lane blocked");
    // Kept structured for the log line, too.
    expect(err!.rpcCode).toBe(-32004);
    expect(err!.rpcData).toEqual(data);
    // What a chat may be shown leaves the payload out.
    expect((err as unknown as { publicMessage?: string }).publicMessage).toBe("imsg rpc send failed (-32004) Mutation lane blocked");

    await channel.stop();
  });

  it("keeps a long string RPC `data` whole, so refusal phrases deep in it still match", async () => {
    const data = `${"context ".repeat(400)}Could not securely open sticker directory`;
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 7 });
        if (req.method === "send") return child.respondError(req.id, -32603, "Internal error", data);
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();
    await expect(channel.send({ chatId: DM_GUID, text: "hi" })).rejects.toThrow(/Could not securely open sticker directory$/);
    await channel.stop();
  });

  it("parses payloads split across stdout chunks", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    const payload = JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message: inboundMessage() } });
    children[0].stdout.emit("data", payload.slice(0, 25));
    children[0].stdout.emit("data", `${payload.slice(25)}\n`);
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    await channel.stop();
  });
});

// --- Child lifecycle --------------------------------------------------------------

describe("imsg rpc child lifecycle", () => {
  it("survives an 'error' on the child's stdin instead of taking the daemon down", async () => {
    // A write onto the pipe of a child that has just died — `killChild` or
    // gap recovery racing an in-flight read receipt or typing tick — emits
    // 'error' on `child.stdin`. Nothing listened on that stream, and an
    // unhandled 'error' on an EventEmitter throws: as an uncaughtException it
    // reaches the daemon's process handler, which logs and exits 1. The whole
    // assistant went down because one fire-and-forget write lost a race with
    // a restart it had itself provoked.
    const debugSpy = vi.spyOn(log, "debug");
    const { channel, children } = makeChannel();
    await channel.start();

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    // `emit("error")` on an emitter with no 'error' listener throws here, the
    // same way the real stream's does inside Node's I/O callback.
    expect(() => children[0].stdin.emit("error", epipe)).not.toThrow();
    expect(debugSpy.mock.calls.some(
      ([obj, msg]) => msg === "imsg rpc stdin error (write to a closed child pipe)"
        && (obj as { err?: unknown }).err === epipe,
    )).toBe(true);

    // And the channel is still usable: the listener swallows the pipe error,
    // it does not tear anything down on its own.
    await channel.send({ chatId: DM_GUID, text: "still here" });
    await channel.stop();
  });

  it("restarts the child with backoff after a crash and resubscribes from the cursor", async () => {
    vi.useFakeTimers();
    const { channel, children, watchChildren } = makeChannel({ config: { restartDelaysMs: [1_000, 5_000] } });
    await channel.start();
    channel.onMessage(vi.fn(async () => true));
    expect(watchChildren()).toHaveLength(1);

    children[0].notifyMessage(inboundMessage({ id: 777, guid: "pre-crash" }));
    await settle();

    children[0].emit("exit", 1, null);
    expect(watchChildren()).toHaveLength(1); // waits out the backoff first

    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchChildren()).toHaveLength(2);

    // The replacement child resubscribes strictly after the last seen rowid.
    const resubscribe = JSON.parse(watchChildren()[1].stdin.lines[0]) as RpcRequest;
    expect(resubscribe.method).toBe("watch.subscribe");
    expect(resubscribe.params.since_rowid).toBe(777);

    // The new child works: inbound flows again.
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);
    watchChildren()[1].notifyMessage(inboundMessage({ id: 778, guid: "post-crash" }));
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    await channel.stop();
  });

  it("escalates the backoff for repeated crashes", async () => {
    vi.useFakeTimers();
    const { channel, children, spawnFn } = makeChannel({ config: { restartDelaysMs: [1_000, 5_000] } });
    await channel.start();

    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    children[1].emit("exit", 1, null);
    // Second crash uses the next backoff step: not yet at 1s...
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    // ...but restarts by 5s.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(spawnFn).toHaveBeenCalledTimes(3);

    await channel.stop();
  });

  it("rejects in-flight requests when the child dies and does not restart after stop", async () => {
    vi.useFakeTimers();
    const { channel, children, spawnFn, mutationChildren } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "watch.unsubscribe") return child.respond(req.id, { ok: true });
        // never answer send — leave it in flight
      },
    });
    await channel.start();

    const inFlight = channel.send({ chatId: DM_GUID, text: "hi" });
    const rejection = expect(inFlight).rejects.toThrow(/imsg rpc child exited/);
    await settle();
    mutationChildren()[0].emit("exit", 0, null);
    await rejection;

    await channel.stop();
    children[0].emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(2); // the watch child and the one mutation child
  });

  it("rejects in-flight requests on stop() instead of leaving them hanging", async () => {
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "send") return; // never answered — must settle on stop
        child.respond(req.id, req.method === "watch.subscribe" ? { subscription: 1 } : { ok: true });
      },
    });
    await channel.start();

    // killChild() nulls this.child before kill(), so the exit event is a stale
    // no-op in handleChildDown — stop() itself must reject what's in flight,
    // else this send never settles (its timeout timer is unref'd).
    const inFlight = channel.send({ chatId: DM_GUID, text: "in flight at shutdown" }).catch((e: Error) => e);
    await settle();
    await channel.stop();
    expect(await inFlight).toBeInstanceOf(Error);
    expect(((await inFlight) as Error).message).toMatch(/stopped while awaiting send/);
  });

  it("restarts the child when the watch stream errors server-side", async () => {
    vi.useFakeTimers();
    const { channel, children, spawnFn } = makeChannel({ config: { restartDelaysMs: [1_000] } });
    await channel.start();

    children[0].emitPayload({ jsonrpc: "2.0", method: "error", params: { subscription: 1, error: { message: "watch died" } } });
    expect(children[0].killed).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    await channel.stop();
  });

  it("fails startup loudly when the first subscribe cannot be established", async () => {
    const { channel } = makeChannel({
      responder: (req, child) => {
        child.respondError(req.id, -32603, "Internal error", "Full Disk Access required");
      },
    });
    await expect(channel.start()).rejects.toThrow(/Full Disk Access/);
    await channel.stop();
  });

  it("recovers the write chain when the child exits before 'drain' fires (round-3 #1)", async () => {
    vi.useFakeTimers();
    let subCount = 0;
    const { channel, children } = makeChannel({
      config: { restartDelaysMs: [1_000] },
      responder: (req, child) => {
        if (req.method === "watch.subscribe") { subCount++; child.respond(req.id, { subscription: subCount }); return; }
        if (req.method === "send") return; // stay pending (and the first one backpressures)
        child.respond(req.id, { ok: true }); // e.g. watch.unsubscribe on stop()
      },
    });
    await channel.start();
    const child0 = mutationChildOf(channel);

    // The next write (a send) backpressures — write() returns false and its
    // chain link parks on 'drain' (which will never fire for this child).
    child0.stdin.backpressureWrites = 1;
    void channel.send({ chatId: DM_GUID, text: "stuck" }).catch(() => {});
    await settle();
    expect(child0.stdin.listenerCount("drain")).toBeGreaterThan(0);

    // The child dies before draining. The parked write must not wedge the
    // write chain: the next request goes out on a new mutation child.
    child0.emit("exit", 1, null);
    await settle();
    expect(child0.stdin.listenerCount("drain")).toBe(0); // parked wait released

    void channel.send({ chatId: DM_GUID, text: "next" }).catch(() => {});
    await settle();
    expect(children).toHaveLength(3);
    expect(children[2].stdin.lines.map((l) => (JSON.parse(l) as RpcRequest).params.text)).toEqual(["next"]);
    await channel.stop();
  });

  it("ignores buffered stdout from an old killed child after restart (round-3 #3)", async () => {
    vi.useFakeTimers();
    const { channel, children } = makeChannel({ config: { restartDelaysMs: [1_000] } });
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);
    const child0 = children[0];

    // Crash + restart so a fresh child becomes current.
    child0.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    const child1 = children[1];

    // A late buffered notification from the DEAD child0 must be dropped — not
    // parsed and dispatched under the new subscription's generation.
    child0.notifyMessage(inboundMessage({ id: 999, guid: "stale-1", text: "from dead child" }));
    await settle();
    expect(handler).not.toHaveBeenCalled();

    // The current child still delivers normally.
    child1.notifyMessage(inboundMessage({ id: 1_000, guid: "live-1", text: "from live child" }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0].id).toBe("live-1");
    await channel.stop();
  });
});

describe("imsg rpc restart on -32004 Mutation lane blocked", () => {
  // children[0] is the watch child; mutation children follow, spawned on use.
  const blockedResponder = (isBlocked: (childIndex: number, req: RpcRequest) => boolean, childIndex: (child: FakeChild) => number): Responder =>
    (req, child) => {
      if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
      if (req.method === "send" && isBlocked(childIndex(child), req)) {
        return child.respondError(req.id, -32004, "Mutation lane blocked", { lane: "send", reason: "busy" });
      }
      child.respond(req.id, { ok: true });
    };

  function laneChannel(isBlocked: (childIndex: number, req: RpcRequest) => boolean, config: Partial<ImsgChannelConfig> = {}) {
    let children: FakeChild[] = [];
    const made = makeChannel({ responder: blockedResponder(isBlocked, (c) => children.indexOf(c)), config });
    children = made.children;
    const sends = () => made.requests().filter((r) => r.method === "send");
    return { ...made, sends };
  }

  it("restarts only the mutation child and retries the refused send there once; the watch stream is untouched", async () => {
    const { channel, children, sends, watchChildren, mutationChildren } = laneChannel((i) => i === 1);
    await channel.start();
    const handler = vi.fn(async () => true);
    channel.onMessage(handler);

    await expect(channel.send({ chatId: DM_GUID, text: "hello" })).resolves.toBeUndefined();

    // The blocked mutation child was replaced; the retry went to the new one.
    expect(mutationChildren()).toHaveLength(2);
    expect(mutationChildren()[0].killed).toBe(true);
    expect(sends().map((r) => r.params.text)).toEqual(["hello", "hello"]);
    expect(mutationChildren()[1].stdin.lines.map((l) => (JSON.parse(l) as RpcRequest).method)).toEqual(["send"]);

    // The watch child: never killed, subscribed once, still delivering.
    expect(watchChildren()).toHaveLength(1);
    expect(children[0].killed).toBe(false);
    expect(children[0].stdin.lines.map((l) => (JSON.parse(l) as RpcRequest).method)).toEqual(["watch.subscribe"]);
    children[0].notifyMessage(inboundMessage({ id: 801, guid: "after-restart" }));
    await settle(20);
    expect(handler).toHaveBeenCalledTimes(1);

    await channel.stop();
  });

  it("retries only the refused part of a long text, never a part already sent", async () => {
    let sendsOnFirstMutationChild = 0;
    const { channel, sends } = laneChannel((i) => i === 1 && ++sendsOnFirstMutationChild === 2);
    await channel.start();

    // Three parts, each with different words.
    const text = Array.from({ length: 1_700 }, (_, i) => `w${i}`).join(" ");
    await expect(channel.send({ chatId: DM_GUID, text })).resolves.toBeUndefined();

    const parts = sends().map((r) => r.params.text as string);
    // Part 1 once, part 2 refused then retried, part 3 once: nothing doubled.
    expect(parts).toHaveLength(4);
    expect(parts[1]).toBe(parts[2]);
    expect(new Set(parts).size).toBe(3);

    await channel.stop();
  });

  it("retries at most once: a second refusal fails as nothing-sent, with no third attempt", async () => {
    const { channel, sends, mutationChildren } = laneChannel(() => true);
    await channel.start();

    const err = await channel.send({ chatId: DM_GUID, text: "hi" }).then(() => null, (e: unknown) => e as Error & { rpcCode?: number });
    expect(err?.rpcCode).toBe(-32004);
    expect(isNothingSent(err)).toBe(true);
    expect(sends()).toHaveLength(2);
    expect(mutationChildren()).toHaveLength(2);

    await channel.stop();
  });

  it("does not retry when the retried send's outcome is unknown (timeout)", async () => {
    vi.useFakeTimers();
    const { channel, children, mutationChildren } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        // First mutation child: lane blocked. Second: takes the send and never answers.
        if (req.method === "send" && children.indexOf(child) === 1) return child.respondError(req.id, -32004, "Mutation lane blocked");
        if (req.method !== "send") child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const pending = channel.send({ chatId: DM_GUID, text: "hi" }).then(() => null, (e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(31_000);
    const err = await pending;
    expect(err?.message).toMatch(/timed out/);
    // May have been delivered: not nothing-sent, and never sent a third time.
    expect(isNothingSent(err)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children.flatMap((c) => c.stdin.lines).map((l) => (JSON.parse(l) as RpcRequest).method).filter((m) => m === "send")).toHaveLength(2);
    expect(mutationChildren()).toHaveLength(2);

    await channel.stop();
  });

  it("does not restart or retry on an ambiguous failure (no response)", async () => {
    vi.useFakeTimers();
    const { channel, requests, mutationChildren } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        // Takes the send and never answers it.
        if (req.method !== "send") child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const pending = channel.send({ chatId: DM_GUID, text: "hi" }).then(() => null, (e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await pending)?.message).toMatch(/timed out/);
    expect(requests().filter((r) => r.method === "send")).toHaveLength(1);
    expect(mutationChildren()).toHaveLength(1);
    expect(mutationChildren()[0].killed).toBe(false);

    await channel.stop();
  });

  it("waits for other in-flight requests before killing the mutation child, so their outcome stays known", async () => {
    let held: { id: number; child: FakeChild } | null = null;
    const { channel, children, mutationChildren } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send" && children.indexOf(child) === 1) {
          if (req.params.text === "slow") { held = { id: req.id, child }; return; }
          return child.respondError(req.id, -32004, "Mutation lane blocked");
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const slow = channel.send({ chatId: DM_GUID, text: "slow" });
    await settle();
    const blocked = channel.send({ chatId: DM_GUID, text: "blocked" });
    await settle(20);
    // The refused send is waiting; the old mutation child is still up for "slow".
    expect(mutationChildren()).toHaveLength(1);
    expect(mutationChildren()[0].killed).toBe(false);

    held!.child.respond(held!.id, { ok: true });
    await expect(slow).resolves.toBeUndefined();
    await expect(blocked).resolves.toBeUndefined();
    expect(mutationChildren()).toHaveLength(2);
    expect(mutationChildren()[0].killed).toBe(true);

    await channel.stop();
  });

  it("holds a request issued during the restart and sends it on the new mutation child", async () => {
    let held: { id: number; child: FakeChild } | null = null;
    const { channel, children, mutationChildren } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send" && children.indexOf(child) === 1) {
          if (req.params.text === "slow") { held = { id: req.id, child }; return; }
          return child.respondError(req.id, -32004, "Mutation lane blocked");
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const slow = channel.send({ chatId: DM_GUID, text: "slow" });
    await settle();
    const blocked = channel.send({ chatId: DM_GUID, text: "blocked" });
    await settle(20);
    // Issued while the restart waits for "slow": queued, not written to the old child.
    const queued = channel.send({ chatId: DM_GUID, text: "queued" });
    await settle(20);
    const oldTexts = () => mutationChildren()[0].stdin.lines.map((l) => (JSON.parse(l) as RpcRequest).params.text);
    expect(oldTexts()).toEqual(["slow", "blocked"]);

    held!.child.respond(held!.id, { ok: true });
    await expect(Promise.all([slow, blocked, queued])).resolves.toBeDefined();
    expect(oldTexts()).toEqual(["slow", "blocked"]);
    expect(mutationChildren()[1].stdin.lines.map((l) => (JSON.parse(l) as RpcRequest).params.text).sort()).toEqual(["blocked", "queued"]);

    await channel.stop();
  });

  it("fails a request held during the restart as not sent when the channel stops first", async () => {
    const { channel, children, mutationChildren } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send" && children.indexOf(child) === 1) {
          if (req.params.text === "slow") return; // never answered: stop() rejects it
          return child.respondError(req.id, -32004, "Mutation lane blocked");
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const slow = channel.send({ chatId: DM_GUID, text: "slow" }).catch((e: unknown) => e);
    await settle();
    const blocked = channel.send({ chatId: DM_GUID, text: "blocked" }).then(() => null, (e: unknown) => e as Error);
    await settle(20);
    const queued = channel.send({ chatId: DM_GUID, text: "queued" }).then(() => null, (e: unknown) => e as Error);
    await settle(20);

    await channel.stop(); // kills the old mutation child: "slow" is rejected, the restart finds the channel gone
    await slow;
    const queuedErr = await queued;
    expect(queuedErr?.message).toMatch(/not sent/);
    expect(isNothingSent(queuedErr)).toBe(true);
    expect(isNothingSent(await blocked)).toBe(true);
    expect(mutationChildren()).toHaveLength(1); // no new child after teardown
    expect(children.flatMap((c) => c.stdin.lines).some((l) => l.includes('"queued"'))).toBe(false);
  });

  it("reports a send as not sent when the new mutation child fails to start", async () => {
    const { channel, children } = makeChannel({
      responder: (req, child) => {
        if (children.indexOf(child) === 1 && req.method === "send") return child.respondError(req.id, -32004, "Mutation lane blocked");
        defaultResponder(req, child);
      },
      onSpawn: (child, index) => {
        if (index < 2) return;
        // ENOENT-style spawn failure (the binary went away): no pid, 'error'
        // before anything is answered.
        child.stdin.onLine = null;
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn imsg ENOENT"), { code: "ENOENT" })));
      },
    });
    await channel.start();

    const err = await channel.send({ chatId: DM_GUID, text: "hi" }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/not sent/);
    expect(isNothingSent(err)).toBe(true);
    expect(children[0].killed).toBe(false);

    await channel.stop();
  });

  it("holds a send issued during start() until the watch is subscribed", async () => {
    let finishProbe!: () => void;
    const probe = new Promise<ImsgCapabilities>((resolve) => { finishProbe = () => resolve(CAPS_FULL); });
    const { channel, requests, mutationChildren } = makeChannel({ config: { probeCapabilities: () => probe } });

    const started = channel.start();
    const sent = channel.send({ chatId: DM_GUID, text: "early" });
    await settle(20);
    // Nothing goes out before the watch can see the reply.
    expect(requests().some((r) => r.method === "send")).toBe(false);
    expect(mutationChildren()).toHaveLength(0);

    finishProbe();
    await started;
    await expect(sent).resolves.toBeUndefined();
    const methods = requests().map((r) => r.method);
    expect(methods.indexOf("watch.subscribe")).toBeLessThan(methods.indexOf("send"));

    await channel.stop();
  });

  it("fails a send issued during a start() that fails as not sent", async () => {
    const { channel, requests } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respondError(req.id, -32603, "Internal error", "Full Disk Access required");
        child.respond(req.id, { ok: true });
      },
    });

    const started = channel.start().catch((e: unknown) => e);
    const err = await channel.send({ chatId: DM_GUID, text: "early" }).then(() => null, (e: unknown) => e as Error);
    expect(await started).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/not sent/);
    expect(isNothingSent(err)).toBe(true);
    expect(requests().some((r) => r.method === "send")).toBe(false);

    await channel.stop();
  });

  it("caps restarts within the window, then tells the owner once and stops restarting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    const { channel, sends, mutationChildren, watchChildren } = laneChannel((i) => i >= 1, { laneRestartLimit: 3, laneRestartWindowMs: 10 * 60_000 });
    const notices: ChannelFaultNotice[] = [];
    channel.onOwnerNotice((notice) => { notices.push(notice); return Promise.resolve(true); });
    await channel.start();

    const fail = () => channel.send({ chatId: DM_GUID, text: "x" }).then(() => null, (e: unknown) => e as Error & { rpcCode?: number });
    for (let i = 0; i < 3; i++) expect((await fail())?.rpcCode).toBe(-32004);
    expect(mutationChildren()).toHaveLength(4);
    expect(notices).toHaveLength(0);

    // Fourth refusal inside the window: no restart, no retry, one notice.
    const before = sends().length;
    const err = await fail();
    expect(err?.rpcCode).toBe(-32004);
    expect(isNothingSent(err)).toBe(true);
    expect(mutationChildren()).toHaveLength(4);
    expect(sends().length).toBe(before + 1);
    await settle();
    expect(notices).toEqual([{ kind: "imsgLaneBlocked", restarts: 3, windowMs: 10 * 60_000 }]);

    // Further refusals in the same window do not notify again.
    await fail();
    await settle();
    expect(notices).toHaveLength(1);
    expect(mutationChildren()).toHaveLength(4);

    // Once the oldest restart leaves the window, restarting resumes.
    vi.setSystemTime(new Date("2026-11-21T10:10:01Z"));
    await fail();
    expect(mutationChildren()).toHaveLength(5);
    // The watch stream never restarted through any of it.
    expect(watchChildren()).toHaveLength(1);

    await channel.stop();
  });
});

// --- stdin backpressure (Codex MED #4) ------------------------------------------

describe("imsg stdin backpressure", () => {
  it("holds the next write until 'drain' when a write signals a full pipe", async () => {
    // Hold send responses: an immediate response would (correctly) release the
    // parked write via the response path, hiding the drain gate under test.
    const heldSends: Array<{ id: number }> = [];
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "send") { heldSends.push({ id: req.id }); return; }
        child.respond(req.id, req.method === "watch.subscribe" ? { subscription: 1 } : { ok: true });
      },
    });
    await channel.start();
    const child = mutationChildOf(channel);

    // The first send's write returns false (full pipe); its chain link then
    // waits for 'drain' before the next write is allowed through.
    child.stdin.backpressureWrites = 1;
    const p1 = channel.send({ chatId: DM_GUID, text: "first" });
    await settle();
    expect(sentTexts(child)).toEqual(["first"]);

    // The second send is queued behind the un-drained first write — its bytes
    // must not hit stdin yet.
    const p2 = channel.send({ chatId: DM_GUID, text: "second" });
    await settle();
    expect(sentTexts(child)).toEqual(["first"]);
    expect(child.stdin.listenerCount("drain")).toBeGreaterThan(0);

    // Drain releases the backlog; the held write now goes out, in order.
    child.stdin.emit("drain");
    await settle();
    expect(sentTexts(child)).toEqual(["first", "second"]);

    // Answer the held sends so both calls resolve.
    for (const { id } of heldSends.splice(0)) child.respond(id, { ok: true });
    await Promise.all([p1, p2]);
    await channel.stop();
  });

  it("fails a request cleanly once the pending queue is saturated", async () => {
    // Every send stays pending forever. watch.unsubscribe is still answered:
    // left unanswered, stop() waited out its 3 s request timeout.
    const { channel } = makeChannel({ responder: leavingPending("send") });
    await channel.start();

    const rpc = (channel as unknown as { rpc: { request(method: string, params: Record<string, unknown>): Promise<unknown> } }).rpc;
    const request = rpc.request.bind(rpc);
    for (let i = 0; i < 256; i++) void (request("send", { chat_guid: DM_GUID, text: `x${i}` }) as Promise<unknown>).catch(() => {});

    await expect(request("send", { chat_guid: DM_GUID, text: "overflow" })).rejects.toThrow(/pending queue full/);
    await channel.stop();
  });

  it("skips a queued write whose request already timed out (no late duplicate send) (round-2 #3)", async () => {
    vi.useFakeTimers();
    // Sends stay unanswered: a response to the first send would settle its
    // parked link and release the queued second write before the timeout.
    const { channel } = makeChannel({ responder: leavingPending("send") });
    await channel.start();
    const child = mutationChildOf(channel);

    const rpc = (channel as unknown as { rpc: {
      request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    } }).rpc;
    const request = rpc.request.bind(rpc);

    // The first send backpressures (write returns false), so the second send's
    // write stays QUEUED behind the un-drained first.
    child.stdin.backpressureWrites = 1;
    void (request("send", { chat_guid: DM_GUID, text: "first" }, 60_000) as Promise<unknown>).catch(() => {});
    const p2 = (request("send", { chat_guid: DM_GUID, text: "second" }, 1_000) as Promise<unknown>).catch((e: Error) => e);
    await settle();
    expect(sentTexts(child)).toEqual(["first"]); // second not written — still queued

    // The queued second request times out before drain releases it.
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await p2;
    expect((err as Error).message).toMatch(/timed out/);

    // Drain dequeues the write, but the request is gone → the write is SKIPPED,
    // so no late/duplicate "second" send hits stdin.
    child.stdin.emit("drain");
    await settle();
    expect(sentTexts(child)).toEqual(["first"]);
    await channel.stop();
  });

  it("settles a parked write when its request times out so the chain proceeds (round-4 #2a)", async () => {
    vi.useFakeTimers();
    // Answer only watch.subscribe/unsubscribe; sends stay pending so responses
    // can't resolve the parked link out from under the test.
    const { channel } = makeChannel({ responder: leavingPending("send") });
    await channel.start();
    const child = mutationChildOf(channel);
    const rpc = (channel as unknown as { rpc: {
      request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    } }).rpc;
    const request = rpc.request.bind(rpc);

    // The first send parks on 'drain' (never fires; child stays alive). The
    // second send is queued behind it.
    child.stdin.backpressureWrites = 1;
    const p1 = (request("send", { chat_guid: DM_GUID, text: "first" }, 1_000) as Promise<unknown>).catch((e: Error) => e);
    const p2 = (request("send", { chat_guid: DM_GUID, text: "second" }, 60_000) as Promise<unknown>).catch(() => {});
    await settle();
    expect(sentTexts(child)).toEqual(["first"]); // second queued behind the parked first

    // First request times out → its parked write link settles → the chain
    // proceeds and the second write goes out (never wedged).
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p1 as Error).message).toMatch(/timed out/);
    await settle();
    expect(sentTexts(child)).toEqual(["first", "second"]);
    void p2;
    await channel.stop();
  });

  it("releases a parked write when its response arrives, without waiting for 'drain'", async () => {
    // defaultResponder answers every request — the response itself (proof the
    // child consumed the line) must settle the parked link, so the next write
    // goes out even though 'drain' never fires.
    const { channel } = makeChannel();
    await channel.start();
    const child = mutationChildOf(channel);

    child.stdin.backpressureWrites = 1; // first send parks on a full pipe
    const p1 = channel.send({ chatId: DM_GUID, text: "first" });
    const p2 = channel.send({ chatId: DM_GUID, text: "second" });
    await settle(12);
    expect(sentTexts(child)).toEqual(["first", "second"]);
    await Promise.all([p1, p2]);
    await channel.stop();
  });

  it("replaces a live mutation child that stops draining so the write chain recovers (round-4 #2b)", async () => {
    vi.useFakeTimers();
    let subCount = 0;
    const { channel, children } = makeChannel({
      config: { restartDelaysMs: [1_000], drainWaitTimeoutMs: 5_000 },
      responder: (req, child) => {
        if (req.method === "watch.subscribe") { subCount++; child.respond(req.id, { subscription: subCount }); return; }
        if (req.method === "send") return; // never answer; the first backpressures
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();
    const child0 = mutationChildOf(channel);

    // A send parks on 'drain', and the (alive) child never drains.
    child0.stdin.backpressureWrites = 1;
    const p = channel.send({ chatId: DM_GUID, text: "stuck" }).catch((e: Error) => e);
    await settle();
    expect(child0.stdin.listenerCount("drain")).toBeGreaterThan(0);
    expect(child0.killed).toBe(false);

    // The drain-wait backstop fires: settle the parked link + restart the child.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child0.killed).toBe(true);
    expect(await p).toBeInstanceOf(Error); // the stuck send is rejected on teardown

    // The watch child is untouched; the next send gets a fresh mutation child.
    expect(children[0].killed).toBe(false);
    void channel.send({ chatId: DM_GUID, text: "next" }).catch(() => {});
    await settle();
    expect(children).toHaveLength(3);
    expect(children[2].stdin.lines.map((l) => (JSON.parse(l) as RpcRequest).params.text)).toEqual(["next"]);
    await channel.stop();
  });
});

// --- Child leak on failed subscribe (Codex HIGH #2) -----------------------------

describe("imsg failed-subscribe child cleanup", () => {
  it("kills the spawned child when the initial watch.subscribe fails", async () => {
    const { channel, children } = makeChannel({
      responder: (req, child) => child.respondError(req.id, -32603, "Internal error", "Full Disk Access required"),
    });
    await expect(channel.start()).rejects.toThrow(/Full Disk Access/);
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(true);
    await channel.stop();
  });

  it("kills each failed child across restart backoff (no process leak)", async () => {
    vi.useFakeTimers();
    let subscribeOk = true;
    const { channel, children } = makeChannel({
      config: { restartDelaysMs: [1_000] },
      responder: (req, child) => {
        if (req.method === "watch.subscribe") {
          return subscribeOk ? child.respond(req.id, { subscription: 1 }) : child.respondError(req.id, -32603, "err", "nope");
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();
    expect(children[0].killed).toBe(false);

    // Crash the healthy child; the restart's subscribe now fails.
    subscribeOk = false;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    expect(children[1].killed).toBe(true); // failed subscribe → killed, not leaked

    // Backoff retries; still failing → that child is killed too.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(3);
    expect(children[2].killed).toBe(true);

    // Recovery: subscribe succeeds and the child survives.
    subscribeOk = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(4);
    expect(children[3].killed).toBe(false);
    await channel.stop();
  });

  it("keeps sending through a watch restart whose subscribe fails (mutations have their own child)", async () => {
    vi.useFakeTimers();
    let failSubscribe = false;
    let releaseSubscribe: (() => void) | null = null;
    const { channel, children, watchChildren } = makeChannel({
      config: { restartDelaysMs: [1_000] },
      responder: (req, child) => {
        if (req.method === "watch.subscribe") {
          if (!failSubscribe) return child.respond(req.id, { subscription: 1 });
          // Hold the (doomed) subscribe so a send can be issued mid-restart.
          releaseSubscribe = () => child.respondError(req.id, -32603, "err", "nope");
          return;
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    // Crash the healthy watch child; the restart's subscribe will hang, then fail.
    failSubscribe = true;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchChildren()).toHaveLength(2);

    // A send issued while the watch restart is in flight goes to the mutation
    // child and is answered, whatever happens to the watch.
    await expect(channel.send({ chatId: DM_GUID, text: "during restart" })).resolves.toBeUndefined();

    releaseSubscribe!();
    await settle();
    expect(watchChildren()[1].killed).toBe(true); // the failed subscribe's child is not leaked
    await expect(channel.send({ chatId: DM_GUID, text: "after" })).resolves.toBeUndefined();
    await channel.stop();
  });
});
