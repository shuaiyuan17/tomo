import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchBus } from "../src/watch/bus.js";
import { WatchServer } from "../src/watch/server.js";
import type { ServerFrame, WatchSnapshot } from "../src/watch/protocol.js";
import type { WatchServerDeps } from "../src/watch/server.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function fakeSnapshot(): WatchSnapshot {
  return {
    protocolVersion: 1,
    pid: process.pid,
    startedAt: Date.now(),
    version: "0.0.0-test",
    model: "claude-test",
    channels: ["telegram"],
    sessions: [],
    cron: [],
    nextHeartbeatAt: null,
    costTodayUsd: 0,
    costWeekUsd: 0,
    turnsToday: 0,
    recent: [],
    lastIssue: null,
  };
}

/**
 * Start a server and wait until it is actually listening (and so has chmodded
 * its socket, which happens in the listen callback registered before ours).
 * `start()` returns before the listen completes; a test that connects or
 * stats the socket straight after it raced the kernel, which is what the old
 * fixed 50 ms sleeps papered over.
 */
async function startServer(socketPath: string, deps: Partial<WatchServerDeps> = {}): Promise<WatchServer> {
  const server = new WatchServer(socketPath, {
    getSnapshot: () => fakeSnapshot(),
    sendChat: async () => {},
    ...deps,
  });
  server.start();
  const net = (server as unknown as { server: Server }).server;
  // A Unix-socket listen can complete synchronously (`listening` is already
  // true) while the 'listening' event, and with it the chmod callback, is
  // still queued on the next tick. Waiting one macrotask lets every queued
  // tick run first.
  if (!net.listening) await once(net, "listening");
  await new Promise((r) => setImmediate(r));
  return server;
}

interface CollectHooks {
  onConnect?: (socket: Socket) => void;
  /** Called after each frame is recorded, with every frame so far. */
  onFrame?: (frames: ServerFrame[], socket: Socket) => void;
}

/** Connect and collect NDJSON frames until `count` arrive (or timeout). */
function collectFrames(socketPath: string, count: number, hooks: CollectHooks = {}): Promise<ServerFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ServerFrame[] = [];
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out with ${frames.length}/${count} frames: ${JSON.stringify(frames)}`));
    }, 3000);
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => hooks.onConnect?.(socket));
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        frames.push(JSON.parse(line) as ServerFrame);
        if (frames.length >= count) {
          clearTimeout(timer);
          socket.end();
          resolve(frames);
          return;
        }
        hooks.onFrame?.(frames, socket);
      }
    });
  });
}

/** Write one raw line once connected. */
const writeOnConnect = (line: string): CollectHooks => ({ onConnect: (socket) => socket.write(line + "\n") });

describe("WatchServer", () => {
  let dir: string;
  let socketPath: string;
  let server: WatchServer | null = null;

  beforeEach(() => {
    watchBus.reset();
    dir = mkdtempSync(join(tmpdir(), "tomo-watch-"));
    socketPath = join(dir, "watch.sock");
  });

  afterEach(() => {
    server?.stop();
    server = null;
    watchBus.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends a snapshot on connect, then relays bus events", async () => {
    server = await startServer(socketPath);

    // Publish only once the snapshot frame is in: by then the server has
    // registered this client, so the event cannot race the connection.
    const frames = await collectFrames(socketPath, 2, {
      onFrame: (got) => { if (got.length === 1) watchBus.publish({ type: "heartbeat" }); },
    });

    expect(frames[0].kind).toBe("snapshot");
    if (frames[0].kind === "snapshot") {
      expect(frames[0].snapshot.model).toBe("claude-test");
    }
    expect(frames[1]).toMatchObject({ kind: "event", event: { type: "heartbeat" } });
  });

  it("routes send frames to sendChat and acks", async () => {
    const sent: string[] = [];
    server = await startServer(socketPath, { sendChat: async (text) => { sent.push(text); } });

    const frames = await collectFrames(socketPath, 2, writeOnConnect(JSON.stringify({ kind: "send", text: "hello tomo" })));

    expect(sent).toEqual(["hello tomo"]);
    expect(frames.find((f) => f.kind === "send-result")).toMatchObject({ ok: true });
  });

  it("reports sendChat failures without dropping the connection", async () => {
    server = await startServer(socketPath, { sendChat: async () => { throw new Error("no dm session"); } });

    const frames = await collectFrames(socketPath, 2, writeOnConnect(JSON.stringify({ kind: "send", text: "hi" })));

    expect(frames.find((f) => f.kind === "send-result")).toMatchObject({ ok: false, error: "no dm session" });
  });

  // Each of these but the first parses fine, so the old cast handed it
  // straight to `frame.kind` — a TypeError on `null`, raised outside the try of
  // a fire-and-forget handler and surfacing as an unhandled rejection.
  it.each([
    ["this is not json", "invalid frame"],
    ["null", "invalid frame"],
    ["42", "invalid frame"],
    ["[1]", "invalid frame"],
    ['"str"', "invalid frame"],
    ["true", "invalid frame"],
    ['{"text":"no kind"}', "invalid frame"],
    // Well-shaped, unknown kind: answered, and the client is not dropped.
    [JSON.stringify({ kind: "teleport" }), "unsupported frame"],
  ])("answers the client frame %s with %j", async (payload, error) => {
    server = await startServer(socketPath, { sendChat: async () => { throw new Error("must not be called"); } });

    const frames = await collectFrames(socketPath, 2, writeOnConnect(payload));
    expect(frames.find((f) => f.kind === "send-result")).toMatchObject({ ok: false, error });
  });

  it("destroys a client that streams a line past the 64KB cap", async () => {
    server = await startServer(socketPath);

    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("error", () => {}); // the server's destroy() can land as ECONNRESET
    socket.resume(); // drain the snapshot frame, or 'close' never fires
    // No newline: the server buffers until the guard trips.
    socket.write("x".repeat(70 * 1024));
    await closed;
    expect(socket.destroyed).toBe(true);
  }, 10_000);

  it("supports multiple concurrent clients", async () => {
    server = await startServer(socketPath);

    // Publish once BOTH clients hold their snapshot, so both are registered:
    // the old fixed 100 ms wait did not know whether client b had connected.
    let snapshots = 0;
    const onFrame = (got: ServerFrame[]) => {
      if (got.length === 1 && ++snapshots === 2) watchBus.publish({ type: "heartbeat" });
    };
    const [a, b] = await Promise.all([
      collectFrames(socketPath, 2, { onFrame }),
      collectFrames(socketPath, 2, { onFrame }),
    ]);

    expect(a[1]).toMatchObject({ kind: "event", event: { type: "heartbeat" } });
    expect(b[1]).toMatchObject({ kind: "event", event: { type: "heartbeat" } });
  });

  // This is also the eviction test: a client that connects and stops reading
  // must be dropped from the server's set once its write buffer passes the
  // cap, and here the eviction's own warning feeds back into the bus.
  it("does not recurse when the slow-client warning itself hits the watch bus", async () => {
    // The real logger publishes warn/error back onto the watch bus — the
    // module mock severs that edge, so restore it here: this is exactly the
    // feedback loop that made the eviction path re-enter writeLine.
    const { log } = await import("../src/logger.js");
    const warn = log.warn as ReturnType<typeof vi.fn>;
    warn.mockClear(); // shared module mock — drop calls recorded by earlier tests
    warn.mockImplementation(() => {
      watchBus.publish({ type: "issue", level: "warn", msg: "Watch client too slow; disconnected it" });
    });

    try {
      server = await startServer(socketPath);

      const socket = createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("error", reject);
      });
      socket.pause();

      const clients = (server as unknown as { clients: Set<unknown> }).clients;
      const bigMsg = "x".repeat(64 * 1024);
      const deadline = Date.now() + 5000;
      while (clients.size > 0 && Date.now() < deadline) {
        watchBus.publish({ type: "issue", level: "warn", msg: bigMsg });
        await new Promise((r) => setImmediate(r));
      }

      expect(clients.size).toBe(0);
      // One eviction, one warning — not thousands from re-entry.
      expect(warn).toHaveBeenCalledTimes(1);
      socket.destroy();
    } finally {
      warn.mockReset();
    }
  }, 10_000);

  it("recovers from a stale socket file on start", async () => {
    // A crashed daemon leaves a file at the path, and listen() then fails
    // with EADDRINUSE. It cannot be made in-process by closing a server
    // (Node unlinks a Unix socket on close(), which is what the old version
    // of this test did, so it never had a stale file to recover from), so put
    // a plain leftover file there.
    writeFileSync(socketPath, "");

    server = await startServer(socketPath);

    const frames = await collectFrames(socketPath, 1);
    expect(frames[0].kind).toBe("snapshot");
  });

  it("makes the socket owner-only: it carries transcripts and accepts chat sends", async () => {
    server = await startServer(socketPath);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("stop() removes the socket file and drops connected clients", async () => {
    server = await startServer(socketPath);
    const socket = createConnection(socketPath);
    socket.on("error", () => {});
    socket.resume();
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await once(socket, "connect");

    server.stop();
    server = null;

    expect(existsSync(socketPath)).toBe(false);
    await closed;
  });
});
