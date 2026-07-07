import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchBus } from "../src/watch/bus.js";
import { WatchServer } from "../src/watch/server.js";
import type { ServerFrame, WatchSnapshot } from "../src/watch/protocol.js";

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

/** Connect and collect NDJSON frames until `count` arrive (or timeout). */
function collectFrames(socketPath: string, count: number, onConnect?: (socket: Socket) => void): Promise<ServerFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ServerFrame[] = [];
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out with ${frames.length}/${count} frames: ${JSON.stringify(frames)}`));
    }, 3000);
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => onConnect?.(socket));
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) frames.push(JSON.parse(line) as ServerFrame);
        if (frames.length >= count) {
          clearTimeout(timer);
          socket.end();
          resolve(frames);
          return;
        }
      }
    });
  });
}

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
    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
    });
    server.start();

    const frames = await collectFrames(socketPath, 2, () => {
      // Publish once we're connected; the snapshot frame arrives first.
      setTimeout(() => watchBus.publish({ type: "heartbeat" }), 50);
    });

    expect(frames[0].kind).toBe("snapshot");
    if (frames[0].kind === "snapshot") {
      expect(frames[0].snapshot.model).toBe("claude-test");
    }
    expect(frames[1]).toMatchObject({ kind: "event", event: { type: "heartbeat" } });
  });

  it("routes send frames to sendChat and acks", async () => {
    const sent: string[] = [];
    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async (text) => { sent.push(text); },
    });
    server.start();

    const frames = await collectFrames(socketPath, 2, (socket) => {
      socket.write(JSON.stringify({ kind: "send", text: "hello tomo" }) + "\n");
    });

    expect(sent).toEqual(["hello tomo"]);
    expect(frames.find((f) => f.kind === "send-result")).toMatchObject({ ok: true });
  });

  it("reports sendChat failures without dropping the connection", async () => {
    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => { throw new Error("no dm session"); },
    });
    server.start();

    const frames = await collectFrames(socketPath, 2, (socket) => {
      socket.write(JSON.stringify({ kind: "send", text: "hi" }) + "\n");
    });

    expect(frames.find((f) => f.kind === "send-result")).toMatchObject({ ok: false, error: "no dm session" });
  });

  it("rejects malformed client frames gracefully", async () => {
    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
    });
    server.start();

    const frames = await collectFrames(socketPath, 2, (socket) => {
      socket.write("this is not json\n");
    });

    expect(frames.find((f) => f.kind === "send-result")).toMatchObject({ ok: false, error: "invalid frame" });
  });

  it("supports multiple concurrent clients", async () => {
    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
    });
    server.start();

    const [a, b] = await Promise.all([
      collectFrames(socketPath, 2, () => setTimeout(() => watchBus.publish({ type: "heartbeat" }), 100)),
      collectFrames(socketPath, 2),
    ]);

    expect(a[1]).toMatchObject({ kind: "event", event: { type: "heartbeat" } });
    expect(b[1]).toMatchObject({ kind: "event", event: { type: "heartbeat" } });
  });

  it("disconnects a client that stops reading instead of buffering forever", async () => {
    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
    });
    server.start();

    // Connect but never read: pause() stops consuming, so the kernel buffer
    // fills and further frames pile up in the server's writableLength.
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("error", reject);
    });
    socket.pause();

    // Assert server-side (the paused client won't see 'close' while paused):
    // the server must evict the stalled client from its set.
    const clients = (server as unknown as { clients: Set<unknown> }).clients;
    const bigMsg = "x".repeat(64 * 1024);
    const deadline = Date.now() + 5000;
    while (clients.size > 0 && Date.now() < deadline) {
      watchBus.publish({ type: "issue", level: "warn", msg: bigMsg });
      await new Promise((r) => setImmediate(r));
    }

    expect(clients.size).toBe(0);
    socket.destroy();
  }, 10_000);

  it("recovers from a stale socket file on start", async () => {
    // First server leaves a socket file behind (crash simulation: no stop()).
    const first = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
    });
    first.start();
    await new Promise((r) => setTimeout(r, 50));
    // Simulate crash: close the server handle but leave the file.
    (first as unknown as { server: { close(): void } }).server.close();

    server = new WatchServer(socketPath, {
      getSnapshot: () => fakeSnapshot(),
      sendChat: async () => {},
    });
    server.start();

    const frames = await collectFrames(socketPath, 1);
    expect(frames[0].kind).toBe("snapshot");
  });
});
