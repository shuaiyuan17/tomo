// Shared fakes for the ImsgChannel tests (tests/imsg-*.test.ts): a fake
// `imsg rpc` child speaking newline-delimited JSON-RPC over fake stdio, the
// capability fixtures the channel probes, and a `makeChannel` that wires them
// into an ImsgChannel with chat.db lookups stubbed out.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFailed, vi } from "vitest";
import { ImsgChannel, type ImsgCapabilities, type ImsgChannelConfig } from "../../src/channels/imessage-imsg.js";
import { NULL_SERVICE_LOOKUP } from "../../src/channels/imsg-satellite.js";
import { NULL_ATTACHMENT_LOOKUP } from "../../src/channels/imsg-attachment-lookup.js";

// --- Fake `imsg rpc` child ----------------------------------------------

export type RpcRequest = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };

export class FakeStdin extends EventEmitter {
  writable = true;
  lines: string[] = [];
  onLine: ((req: RpcRequest) => void) | null = null;
  /** When >0, the next N write() calls return false (full pipe). The test must
   *  emit 'drain' manually to release the writer — so the paused state is
   *  observable instead of racing away in the same microtask flush. */
  backpressureWrites = 0;

  write(line: string, cb?: (err?: Error | null) => void): boolean {
    this.lines.push(line);
    const req = JSON.parse(line) as RpcRequest;
    // Deliver asynchronously like a real pipe.
    queueMicrotask(() => this.onLine?.(req));
    cb?.(null);
    if (this.backpressureWrites > 0) {
      this.backpressureWrites--;
      return false;
    }
    return true;
  }
}

export class FakeStream extends EventEmitter {
  setEncoding(_enc: string): this { return this; }
}

export class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Emit one newline-delimited JSON payload on stdout. */
  emitPayload(payload: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  }

  respond(id: number, result: Record<string, unknown>): void {
    this.emitPayload({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string, data?: unknown): void {
    this.emitPayload({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  }

  notifyMessage(message: Record<string, unknown>, subscription = 1): void {
    this.emitPayload({ jsonrpc: "2.0", method: "message", params: { subscription, message } });
  }
}

export type Responder = (req: RpcRequest, child: FakeChild) => void;

export const defaultResponder: Responder = (req, child) => {
  if (req.method === "watch.subscribe") {
    child.respond(req.id, { subscription: 1 });
    return;
  }
  child.respond(req.id, { ok: true });
};

export const CAPS_FULL: ImsgCapabilities = {
  rpcMethods: new Set(["send", "send.rich", "tapback", "typing", "read", "message.unsend", "message.edit", "watch.subscribe"]),
  advancedFeatures: true,
  selectors: { retractMessagePart: true, editMessageItem: false, editMessage: false, editMessageItemTranslation: false },
  typingIndicators: true,
  readReceipts: true,
};

export const CAPS_BASIC: ImsgCapabilities = {
  rpcMethods: new Set(["send", "watch.subscribe"]),
  advancedFeatures: false,
  selectors: {},
  typingIndicators: false,
  readReceipts: false,
};

/** Bridge with the imsg 0.13 rich-link selectors injected. */
export const CAPS_RICHLINK: ImsgCapabilities = {
  ...CAPS_FULL,
  selectors: { ...CAPS_FULL.selectors, urlPreviewMessage: true, sendRichLinkAction: true },
};

/** Bridge with the imsg 0.13 sticker surface: send.sticker RPC + stickerSend selector. */
export const CAPS_STICKER: ImsgCapabilities = {
  ...CAPS_FULL,
  rpcMethods: new Set([...CAPS_FULL.rpcMethods, "send.sticker"]),
  selectors: { ...CAPS_FULL.selectors, stickerSend: true },
};

/** Bridge with the attachment surface: send.attachment RPC + sendAttachment selector. */
export const CAPS_ATTACHMENT: ImsgCapabilities = {
  ...CAPS_FULL,
  rpcMethods: new Set([...CAPS_FULL.rpcMethods, "send.attachment"]),
  selectors: { ...CAPS_FULL.selectors, sendAttachment: true },
};

/** Both the sticker and the attachment surfaces. */
export const CAPS_ALL: ImsgCapabilities = {
  ...CAPS_FULL,
  rpcMethods: new Set([...CAPS_STICKER.rpcMethods, ...CAPS_ATTACHMENT.rpcMethods]),
  selectors: { ...CAPS_STICKER.selectors, ...CAPS_ATTACHMENT.selectors },
};

export function makeChannel(options: {
  caps?: ImsgCapabilities;
  responder?: Responder;
  config?: Partial<ImsgChannelConfig>;
  /** Called with each child as it is spawned (0 = the first), after its
   *  responder is wired — e.g. to make a later spawn fail. */
  onSpawn?: (child: FakeChild, index: number) => void;
} = {}) {
  const children: FakeChild[] = [];
  const responder = options.responder ?? defaultResponder;
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    child.stdin.onLine = (req) => responder(req, child);
    children.push(child);
    options.onSpawn?.(child, children.length - 1);
    return child;
  });
  const channel = new ImsgChannel({
    cliPath: "imsg",
    spawnFn: spawnFn as never,
    probeCapabilities: async () => options.caps ?? CAPS_FULL,
    // Never touch the real chat.db from tests: default to a no-op service
    // lookup so satellite detection is off unless a test injects its own.
    serviceLookup: NULL_SERVICE_LOOKUP,
    attachmentLookup: NULL_ATTACHMENT_LOOKUP,
    ...options.config,
  });
  // A test that fails mid-way never reaches its own `await channel.stop()`,
  // which would leave the channel's timers and fake children running into the
  // next test. Stop it for a failed test only: a passing test stops (or
  // deliberately does not start) its channel itself.
  let stopped = false;
  const stop = channel.stop.bind(channel);
  channel.stop = async () => {
    stopped = true;
    await stop();
  };
  onTestFailed(async () => {
    if (!stopped) await stop().catch(() => {});
  });
  return {
    channel,
    children,
    spawnFn,
    requests: () => children.flatMap((c) => c.stdin.lines.map((l) => JSON.parse(l) as RpcRequest)),
    /** Children that carry the watch stream (they subscribed). */
    watchChildren: () => children.filter(isWatchChild),
    /** Children that carry mutations (never subscribed). */
    mutationChildren: () => children.filter((c) => !isWatchChild(c)),
  };
}

export const isWatchChild = (child: FakeChild): boolean => child.stdin.lines.some((l) => (JSON.parse(l) as RpcRequest).method === "watch.subscribe");

/** The channel's mutation child (spawned now if there is none), as its fake. */
export function mutationChildOf(channel: ImsgChannel): FakeChild {
  const rpc = (channel as unknown as { rpc: { mutationChild(): { child: unknown } | null } }).rpc;
  return rpc.mutationChild()!.child as FakeChild;
}

export const DM_GUID = "any;-;+15551234567";
export const GROUP_GUID = "any;+;a70f2f5b3ea847759d38c0b8e3cba57d";

export const inboundMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 100,
  guid: "msg-guid-1",
  chat_id: 1,
  chat_guid: DM_GUID,
  chat_identifier: "+15551234567",
  chat_name: "",
  is_group: false,
  is_from_me: false,
  sender: "+15551234567",
  sender_name: "Alice Smith",
  text: "hello there",
  created_at: "2026-07-07T10:00:00.000Z",
  attachments: [],
  ...overrides,
});

export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** `defaultResponder`, except the named methods are never answered: those
 *  requests stay pending. Everything else (watch.subscribe, watch.unsubscribe
 *  on stop, ...) is answered, so stop() does not wait out a request timeout. */
export function leavingPending(...methods: string[]): Responder {
  return (req, child) => {
    if (!methods.includes(req.method)) defaultResponder(req, child);
  };
}

/** The `text` param of every `send` a child was asked for, in order. */
export function sentTexts(child: FakeChild): unknown[] {
  return child.stdin.lines
    .map((l) => JSON.parse(l) as RpcRequest)
    .filter((r) => r.method === "send")
    .map((r) => r.params.text);
}

/** vi.waitFor polling every 5 ms instead of its default 50 ms: the channel
 *  usually settles within a few microtask turns, and 50 ms per wait added up
 *  to seconds across these files. */
export function waitFor<T>(fn: () => T | Promise<T>, options: { timeout?: number } = {}): Promise<T> {
  return vi.waitFor(fn, { interval: 5, ...options });
}

/** Fake setTimeout/setInterval/Date but keep setImmediate real, so real fs IO
 *  can complete while the channel's clocks are under the test's control. */
export const useFakeClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });

/** Spin real IO turns (setImmediate) `rounds` times. */
export async function flushIo(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Spin real IO turns until `cond` holds, and throw if it never does. Bounded
 *  by REAL time (performance.now is not faked), not by a turn count: how many
 *  loop turns a stat/readFile/write takes depends on the machine and on
 *  coverage instrumentation, which is exactly what made fixed counts flaky on
 *  CI. It throws rather than returning at the bound, so a test waiting for
 *  something that never happens fails instead of carrying on as if it had. */
export async function ioUntil(cond: () => boolean, maxMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start >= maxMs) throw new Error(`ioUntil: condition still false after ${maxMs} ms`);
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Run `fn` with a fresh temp directory, removed afterwards whatever happens. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Magic bytes of the image formats the inbound path sniffs. The HEIC one is a
 *  bare `ftyp` box with major brand `heic` and compatible brand `mif1`. */
export const HEIC_BYTES = Buffer.from("000000246674797068656963000000006d696631", "hex");
export const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
