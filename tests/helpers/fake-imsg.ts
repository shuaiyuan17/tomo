// Shared fakes for the ImsgChannel tests (tests/imsg-*.test.ts): a fake
// `imsg rpc` child speaking newline-delimited JSON-RPC over fake stdio, the
// capability fixtures the channel probes, and a `makeChannel` that wires them
// into an ImsgChannel with chat.db lookups stubbed out.
import { EventEmitter } from "node:events";
import { vi } from "vitest";
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

export function makeChannel(options: {
  caps?: ImsgCapabilities;
  responder?: Responder;
  config?: Partial<ImsgChannelConfig>;
} = {}) {
  const children: FakeChild[] = [];
  const responder = options.responder ?? defaultResponder;
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    child.stdin.onLine = (req) => responder(req, child);
    children.push(child);
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
