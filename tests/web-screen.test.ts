import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request, type IncomingMessage } from "node:http";
import { consoleStateFromSession, macScreenSource, MAX_FRAME_BYTES, parseShot, ScreenLoop, type ConsoleState, type ScreenFrame, type ScreenShot, type ScreenSource } from "../src/web/screen.js";
import { chmodSync } from "node:fs";
import { startWebHttp } from "../src/web/http.js";
import { WebData } from "../src/web/data.js";
import { WebChannel } from "../src/channels/web.js";
import { SessionStore } from "../src/sessions/store.js";
import type { WebBootstrap } from "../src/web/protocol.js";
import { clampGeometry, defaultGeometry, MAX_WIDTH, MIN_WIDTH, parseScreenEvent, readGeometry, readScreen, streamWanted, updatedAgo, windowHeight, writeGeometry } from "../web/src/screen-stream.js";

/** `capture` counts real pictures taken; `shoot` is the source's one call (lock check, then picture if unlocked). */
function fakeSource(state: ConsoleState = "unlocked") {
  const source = {
    state,
    capture: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, source.capture.mock.calls.length])),
    shoot: vi.fn(async (): Promise<ScreenShot> => source.state === "unlocked" ? { state: "unlocked", jpeg: await source.capture() } : { state: source.state }),
  };
  return source as typeof source & ScreenSource;
}

describe("ScreenLoop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never captures without a viewer, and stops when the last one leaves", async () => {
    const source = fakeSource();
    const loop = new ScreenLoop(source);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.capture).not.toHaveBeenCalled();
    const frames: ScreenFrame[] = [];
    const leave = loop.subscribe(1, (frame) => frames.push(frame));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(source.capture).toHaveBeenCalledTimes(3); // now, +1s, +2s
    leave();
    expect(loop.running).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.capture).toHaveBeenCalledTimes(3);
    expect(frames.every((frame) => frame.status === "live" && frame.jpeg)).toBe(true);
  });

  it("shares one loop between viewers, at the fastest rate any of them asked for", async () => {
    const source = fakeSource();
    const loop = new ScreenLoop(source);
    const a: ScreenFrame[] = [], b: ScreenFrame[] = [];
    const leaveA = loop.subscribe(0.5, (frame) => a.push(frame));
    await vi.advanceTimersByTimeAsync(4_100); // 0.5 fps: now, +2s, +4s
    expect(source.capture).toHaveBeenCalledTimes(3);
    const leaveB = loop.subscribe(2, (frame) => b.push(frame));
    await vi.advanceTimersByTimeAsync(2_000); // b's immediate frame, then every 500 ms
    const shared = source.capture.mock.calls.length;
    expect(shared).toBeGreaterThanOrEqual(7);
    expect(shared).toBeLessThanOrEqual(8);
    // Both viewers got the same frames from the same captures.
    expect(a.slice(-b.length).map((f) => f.jpeg)).toEqual(b.map((f) => f.jpeg));
    leaveB();
    const before = source.capture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_100);
    expect(source.capture.mock.calls.length - before).toBeLessThanOrEqual(3); // back to 0.5 fps
    leaveA();
    expect(loop.viewerCount).toBe(0);
  });

  it("does not capture a locked or vacated screen, and says so", async () => {
    const source = fakeSource("locked");
    const loop = new ScreenLoop(source);
    const frames: ScreenFrame[] = [];
    const leave = loop.subscribe(1, (frame) => frames.push(frame));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(source.capture).not.toHaveBeenCalled();
    expect(frames.map((f) => f.status)).toEqual(["locked", "locked"]);
    source.state = "away";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(frames.at(-1)).toMatchObject({ status: "away" });
    expect(frames.at(-1)!.jpeg).toBeUndefined();
    leave();
  });

  it("reports a failed, empty or oversized capture instead of a picture", async () => {
    const source = fakeSource();
    source.capture.mockRejectedValueOnce(new Error("broken")).mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.alloc(MAX_FRAME_BYTES + 1));
    const frames: ScreenFrame[] = [];
    const leave = new ScreenLoop(source).subscribe(1, (frame) => frames.push(frame));
    await vi.advanceTimersByTimeAsync(2_100);
    expect(frames.map((f) => f.status)).toEqual(["unavailable", "unavailable", "too_large"]);
    leave();
  });

  it("fails closed when the lock state cannot be confirmed", async () => {
    const source = fakeSource("unknown");
    const frames: ScreenFrame[] = [];
    const leave = new ScreenLoop(source).subscribe(1, (frame) => frames.push(frame));
    await vi.advanceTimersByTimeAsync(100);
    expect(source.capture).not.toHaveBeenCalled();
    expect(frames).toEqual([{ status: "unconfirmed", capturedAt: expect.any(Number) }]);
    leave();
  });

  it("discards a capture that returns after every viewer left, and stays stopped", async () => {
    let release: (shot: ScreenShot) => void = () => {};
    const source = { shoot: vi.fn(() => new Promise<ScreenShot>((resolve) => { release = resolve; })) };
    const loop = new ScreenLoop(source);
    const frames: ScreenFrame[] = [];
    const leave = loop.subscribe(2, (frame) => frames.push(frame));
    expect(source.shoot).toHaveBeenCalledTimes(1);
    leave();
    release({ state: "unlocked", jpeg: Buffer.from([0xff, 0xd8]) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames).toEqual([]);
    expect(source.shoot).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(false);
  });
});

describe("lock state (fail closed)", () => {
  const complete = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, kCGSSessionUserNameKey: "owner" };
  it("reads this process's own session", () => {
    expect(consoleStateFromSession(complete)).toBe("unlocked");
    expect(consoleStateFromSession({ ...complete, CGSSessionScreenIsLocked: true })).toBe("locked");
    expect(consoleStateFromSession({ ...complete, CGSSessionScreenIsLocked: 1 })).toBe("locked");
    expect(consoleStateFromSession({ ...complete, kCGSSessionOnConsoleKey: false })).toBe("away");
  });
  it.each([
    ["no session", null],
    ["not an object", "session"],
    ["console flag missing", { kCGSessionLoginDoneKey: true }],
    ["login not done", { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: false }],
    ["login flag missing", { kCGSSessionOnConsoleKey: true }],
    ["lock flag of an unexpected type", { ...complete, CGSSessionScreenIsLocked: "no" }],
  ])("is unknown with %s", (_name, session) => {
    expect(consoleStateFromSession(session)).toBe("unknown");
  });
  it("never takes a picture from helper output it cannot trust", () => {
    expect(() => parseShot("not json")).toThrow();
    expect(parseShot(JSON.stringify({ session: null, jpeg: "/9j/" }))).toEqual({ state: "unknown" });
    expect(parseShot(JSON.stringify({ session: { ...complete, CGSSessionScreenIsLocked: true }, jpeg: "/9j/" }))).toEqual({ state: "locked" });
    expect(parseShot(JSON.stringify({ session: complete, jpeg: "/9j/" }))).toEqual({ state: "unlocked", jpeg: Buffer.from("/9j/", "base64") });
  });

  describe("the helper process", () => {
    let dir: string;
    beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "tomo-screen-helper-"))); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    const fake = (body: string) => { const path = join(dir, "osascript"); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o700); return path; };
    it("reads as unconfirmed when it fails", async () => {
      await expect(macScreenSource({ osascript: fake("exit 1") }).shoot()).rejects.toThrow("screen helper failed");
    });
    it("is killed and reads as unconfirmed when it hangs", async () => {
      const started = Date.now();
      await expect(macScreenSource({ osascript: fake("sleep 5"), timeoutMs: 200 }).shoot()).rejects.toThrow("screen helper failed");
      expect(Date.now() - started).toBeLessThan(3_000);
    });
    it("passes the session it reports through the fail-closed parser", async () => {
      const out = JSON.stringify({ session: { kCGSSessionOnConsoleKey: true }, jpeg: "/9j/" });
      expect(await macScreenSource({ osascript: fake(`printf '%s' '${out}'`) }).shoot()).toEqual({ state: "unknown" });
    });
    it("ends up as an unconfirmed frame in the loop", async () => {
      const frames: ScreenFrame[] = [];
      const leave = new ScreenLoop(macScreenSource({ osascript: fake("exit 3") })).subscribe(1, (frame) => frames.push(frame));
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      leave();
      expect(frames[0].status).toBe("unconfirmed");
    });
  });
});

describe("screen over HTTP", () => {
  let root: string;
  let service: Awaited<ReturnType<typeof startWebHttp>>;
  let channel: WebChannel;
  let cookie = "";
  let boot: WebBootstrap;
  let source: ReturnType<typeof fakeSource>;
  let loop: ScreenLoop;
  const token = "tomo_web_" + "e".repeat(64);
  const headers = () => ({ "x-tomo-request": "1", "sec-fetch-site": "same-origin", cookie });

  async function start(withScreen = true) {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tomo-web-screen-")));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    const owner = { name: "owner", telegram: ["test-owner"], imessage: [] as string[] };
    const sessionsDir = join(root, "sessions"); const sdkSessionsDir = join(root, "sdk");
    new SessionStore(sessionsDir, 20, sdkSessionsDir).touchSession("dm:owner");
    channel = new WebChannel(owner); channel.onMessage(async () => true);
    source = fakeSource(); loop = new ScreenLoop(source);
    service = await startWebHttp(0, { accessToken: token, assetsDir: root, data: new WebData({ sessionsDir, sdkSessionsDir, owner }),
      ...(withScreen ? { screen: loop } : {}),
      subscribe: (fn) => channel.events.subscribe(fn), rpc: async () => ({ snapshot: channel.snapshot(), replay: null }) });
    const response = await fetch(`http://127.0.0.1:${service.port}/api/v1/bootstrap?t=${token}`, { headers: { "x-tomo-request": "1", "sec-fetch-site": "same-origin" } });
    cookie = response.headers.getSetCookie()[0].split(";")[0];
    boot = await response.json() as WebBootstrap;
  }
  afterEach(async () => { await service?.close(); await channel?.stop(); rmSync(root, { recursive: true, force: true }); cookie = ""; });

  /** Open the stream, collect the first `count` SSE blocks, then close it. */
  function stream(path: string, extra: Record<string, string> = {}, count = 1) {
    return new Promise<{ status: number; headers: IncomingMessage["headers"]; blocks: string[]; close: () => void }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: service.port, path, headers: { ...headers(), ...extra } }, (res) => {
        const blocks: string[] = []; let buffer = "";
        const close = () => { req.destroy(); };
        if (res.statusCode !== 200) { let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, blocks: [text], close })); return; }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk; let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) { blocks.push(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
          if (blocks.length >= count) resolve({ status: 200, headers: res.headers, blocks, close });
        });
      });
      req.on("error", reject); req.end();
    });
  }

  it("needs the cookie, the API header, same-origin and the current epoch", async () => {
    await start();
    const path = `/api/v1/screen?fps=1&epoch=${boot.epoch}`;
    expect((await stream(path, { cookie: "" })).status).toBe(401);
    expect((await stream(path, { "x-tomo-request": "" })).status).toBe(403);
    expect((await stream(path, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await stream(`/api/v1/screen?fps=1&epoch=00000000-0000-4000-8000-000000000000`)).status).toBe(409);
    expect((await stream(`/api/v1/screen?fps=5&epoch=${boot.epoch}`)).status).toBe(400);
    expect(source.capture).not.toHaveBeenCalled();
    expect(boot.capabilities).toEqual({ screen: true, uploads: false });
  });

  it("streams frames with no-store, and stops capturing when the viewer leaves", async () => {
    await start();
    const opened = await stream(`/api/v1/screen?fps=2&epoch=${boot.epoch}`);
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(opened.headers["content-type"]).toBe("text/event-stream");
    const frame = parseScreenEvent(opened.blocks[0])!;
    expect(frame).toMatchObject({ status: "live" });
    expect(Buffer.from(frame.jpeg!, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(loop.viewerCount).toBe(1);
    opened.close();
    await vi.waitFor(() => expect(loop.viewerCount).toBe(0));
    const after = source.capture.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(source.capture.mock.calls.length).toBe(after);
  });

  it("two browsers share one capture loop", async () => {
    await start();
    const a = await stream(`/api/v1/screen?fps=1&epoch=${boot.epoch}`);
    const b = await stream(`/api/v1/screen?fps=1&epoch=${boot.epoch}`);
    expect(loop.viewerCount).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // Two viewers at 1 fps for ~1 s: about two captures, not four.
    expect(source.capture.mock.calls.length).toBeLessThanOrEqual(3);
    a.close(); b.close();
    await vi.waitFor(() => expect(loop.running).toBe(false));
  });

  it("answers 503 where the screen cannot be captured", async () => {
    await start(false);
    expect((await stream(`/api/v1/screen?fps=1&epoch=${boot.epoch}`)).status).toBe(503);
    expect(boot.capabilities).toEqual({ screen: false, uploads: false });
  });
});

describe("browser helpers", () => {
  it("parses frame events and ignores heartbeats and junk", () => {
    expect(parseScreenEvent('event: frame\ndata: {"status":"live","capturedAt":1,"jpeg":"/9j/"}')).toEqual({ status: "live", capturedAt: 1, jpeg: "/9j/" });
    expect(parseScreenEvent(": heartbeat")).toBeNull();
    expect(parseScreenEvent('event: frame\ndata: {"status":"live","capturedAt":1,"jpeg":"<script>"}')).toBeNull();
    expect(parseScreenEvent('event: frame\ndata: {"status":"hacked","capturedAt":1}')).toBeNull();
  });
  it("says how fresh the picture is", () => {
    expect(updatedAgo(10_000, 10_500)).toBe("Updated just now");
    expect(updatedAgo(10_000, 17_000)).toBe("Updated 7s ago");
    expect(updatedAgo(0, 125_000)).toBe("Updated 2 min ago");
  });
});

describe("floating window", () => {
  const desktop = { width: 1440, height: 900 };
  it("opens bottom right, about 480 px wide, clear of the composer and inside the viewport", () => {
    const g = defaultGeometry(desktop);
    expect(g.width).toBe(480);
    expect(g.x + g.width).toBeLessThanOrEqual(desktop.width - 12);
    expect(g.y + windowHeight(g.width)).toBeLessThanOrEqual(desktop.height - 160);
    expect(g.y).toBeGreaterThanOrEqual(12);
  });
  it("clamps position and size into the viewport and the size limits", () => {
    expect(clampGeometry({ x: -500, y: -40, width: 100 }, desktop)).toEqual({ x: 12, y: 12, width: MIN_WIDTH });
    const big = clampGeometry({ x: 5000, y: 5000, width: 5000 }, desktop);
    expect(big.width).toBeLessThanOrEqual(MAX_WIDTH);
    expect(big.x + big.width).toBeLessThanOrEqual(desktop.width - 12);
    expect(big.y + windowHeight(big.width)).toBeLessThanOrEqual(desktop.height - 12);
    // A short viewport limits the width through the 16:10 height.
    const short = clampGeometry({ x: 0, y: 0, width: 1200 }, { width: 1440, height: 400 });
    expect(windowHeight(short.width)).toBeLessThanOrEqual(400 - 24);
  });
  it("restores a saved geometry clamped to today's viewport, and ignores junk", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    expect(readGeometry(storage, desktop)).toEqual(defaultGeometry(desktop));
    writeGeometry(storage, { x: 900, y: 500, width: 520 });
    expect(readGeometry(storage, desktop)).toEqual({ x: 900, y: 500, width: 520 });
    expect(readGeometry(storage, { width: 800, height: 600 })).toEqual(clampGeometry({ x: 900, y: 500, width: 520 }, { width: 800, height: 600 }));
    store.set("tomo-screen-window", '{"x":"a"}');
    expect(readGeometry(storage, desktop)).toEqual(defaultGeometry(desktop));
    store.set("tomo-screen-window", "{oops");
    expect(readGeometry(storage, desktop)).toEqual(defaultGeometry(desktop));
    expect(readGeometry(undefined, desktop)).toEqual(defaultGeometry(desktop));
  });
  it("streams only while open, visible, connected and not paused", () => {
    const on = { open: true, live: true, visible: true, paused: false, epoch: "e" };
    expect(streamWanted(on)).toBe(true);
    for (const off of [{ open: false }, { live: false }, { visible: false }, { paused: true }, { epoch: undefined }]) expect(streamWanted({ ...on, ...off })).toBe(false);
  });
  it("closing the window (aborting) ends the read and the request", async () => {
    let aborted = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('event: frame\ndata: {"status":"live","capturedAt":1,"jpeg":"/9j/"}\n\n'));
        init.signal!.addEventListener("abort", () => { aborted = true; controller.error(new DOMException("aborted", "AbortError")); });
      } });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      const controller = new AbortController();
      const frames: unknown[] = [];
      const done = readScreen(1, "e", controller.signal, (frame) => { frames.push(frame); controller.abort(); });
      await expect(done).rejects.toThrow();
      expect(frames).toHaveLength(1);
      expect(aborted).toBe(true);
    } finally { globalThis.fetch = original; }
  });
});
