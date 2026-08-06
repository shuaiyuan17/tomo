import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { ImsgChannel, type ImsgCapabilities, type ImsgChannelConfig } from "../src/channels/imessage-imsg.js";
import { NULL_SERVICE_LOOKUP, type ServiceLookup } from "../src/channels/imsg-satellite.js";
import { log } from "../src/logger.js";
import { SATELLITE_MARKER } from "../src/channels/text-utils.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Fake `imsg rpc` child ----------------------------------------------

type RpcRequest = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };

class FakeStdin extends EventEmitter {
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

class FakeStream extends EventEmitter {
  setEncoding(_enc: string): this { return this; }
}

class FakeChild extends EventEmitter {
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

  respondError(id: number, code: number, message: string, data?: string): void {
    this.emitPayload({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  }

  notifyMessage(message: Record<string, unknown>, subscription = 1): void {
    this.emitPayload({ jsonrpc: "2.0", method: "message", params: { subscription, message } });
  }
}

type Responder = (req: RpcRequest, child: FakeChild) => void;

const defaultResponder: Responder = (req, child) => {
  if (req.method === "watch.subscribe") {
    child.respond(req.id, { subscription: 1 });
    return;
  }
  child.respond(req.id, { ok: true });
};

const CAPS_FULL: ImsgCapabilities = {
  rpcMethods: new Set(["send", "send.rich", "tapback", "typing", "read", "message.unsend", "message.edit", "watch.subscribe"]),
  advancedFeatures: true,
  selectors: { retractMessagePart: true, editMessageItem: false, editMessage: false },
  typingIndicators: true,
  readReceipts: true,
};

const CAPS_BASIC: ImsgCapabilities = {
  rpcMethods: new Set(["send", "watch.subscribe"]),
  advancedFeatures: false,
  selectors: {},
  typingIndicators: false,
  readReceipts: false,
};

/** Bridge with the imsg 0.13 rich-link selectors injected. */
const CAPS_RICHLINK: ImsgCapabilities = {
  ...CAPS_FULL,
  selectors: { ...CAPS_FULL.selectors, urlPreviewMessage: true, sendRichLinkAction: true },
};

/** Bridge with the imsg 0.13 sticker surface: send.sticker RPC + stickerSend selector. */
const CAPS_STICKER: ImsgCapabilities = {
  ...CAPS_FULL,
  rpcMethods: new Set([...CAPS_FULL.rpcMethods, "send.sticker"]),
  selectors: { ...CAPS_FULL.selectors, stickerSend: true },
};

function makeChannel(options: {
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
    ...options.config,
  });
  return { channel, children, spawnFn, requests: () => children.flatMap((c) => c.stdin.lines.map((l) => JSON.parse(l) as RpcRequest)) };
}

const DM_GUID = "any;-;+15551234567";
const GROUP_GUID = "any;+;a70f2f5b3ea847759d38c0b8e3cba57d";

const inboundMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

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

  it("parses payloads split across stdout chunks", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    const payload = JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1, message: inboundMessage() } });
    children[0].stdout.emit("data", payload.slice(0, 25));
    children[0].stdout.emit("data", `${payload.slice(25)}\n`);
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    await channel.stop();
  });
});

// --- Inbound mapping ---------------------------------------------------------

describe("imsg inbound message mapping", () => {
  it("maps a DM to an IncomingMessage with the chat.db chat_guid as chatId", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage());
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg).toMatchObject({
      id: "msg-guid-1",
      chatId: DM_GUID, // verbatim — session keys survive the BlueBubbles cutover
      senderName: "Alice Smith",
      senderId: "+15551234567",
      text: "hello there",
      isGroup: false,
      isMentioned: false,
    });
    expect(msg.timestamp).toBe(Date.parse("2026-07-07T10:00:00.000Z"));
    await channel.stop();
  });

  it("normalizes formatted sender handles into senderId", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ sender: "+1 (555) 123-4567" }));
    await settle();

    expect(handler.mock.calls[0][0].senderId).toBe("+15551234567");
    await channel.stop();
  });

  it("maps a group message as mentioned with its chat title", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      chat_guid: GROUP_GUID,
      chat_name: "Family",
      is_group: true,
      guid: "group-msg-1",
    }));
    await settle();

    const msg = handler.mock.calls[0][0];
    expect(msg).toMatchObject({
      chatId: GROUP_GUID,
      isGroup: true,
      isMentioned: true,
      chatTitle: "Family",
    });
    await channel.stop();
  });

  it("prefixes reply context from the inline reply_to_text (no lookup round-trip)", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "reply-guid-1",
      text: "sounds good",
      reply_to_guid: "orig-guid",
      reply_to_text: "dinner friday?",
      reply_to_sender: "+15551234567",
      thread_originator_guid: "orig-guid",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe('[replying to: "dinner friday?"] sounds good');
    await channel.stop();
  });

  it("attaches NO reply context when thread_originator_guid is absent (reply_to_guid alone is not a reply)", async () => {
    // chat.db populates message.reply_to_guid on virtually every row (it
    // points at the preceding message — usually our own last outbound), and
    // imsg resolves reply_to_text from it. Keying reply context on it tagged
    // every plain inbound send as [replying to: "<our latest message>"].
    // Only thread_originator_guid marks a genuine long-press → Reply.
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "plain-guid-1",
      text: "早啊",
      reply_to_guid: "our-last-outbound-guid",
      reply_to_text: "our latest outbound message",
      reply_to_sender: "me",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe("早啊");
    await channel.stop();
  });

  it("quotes the thread originator from the recent ring when imsg left reply_to_text unresolved", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    // Seed the ring with the originator (an is_from_me watch row).
    children[0].notifyMessage(inboundMessage({
      id: 100,
      guid: "orig-guid-ring",
      text: "dinner friday?",
      is_from_me: true,
    }));
    await settle();
    children[0].notifyMessage(inboundMessage({
      id: 101,
      guid: "reply-guid-3",
      text: "sounds good",
      thread_originator_guid: "orig-guid-ring",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe('[replying to: "dinner friday?"] sounds good');
    await channel.stop();
  });

  it("degrades to a quote-less reply marker when the originator text is unavailable", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "reply-guid-2",
      text: "still arrives",
      thread_originator_guid: "orig-gone",
    }));
    await settle();

    expect(handler.mock.calls[0][0].text).toBe("[replying to an earlier message] still arrives");
    await channel.stop();
  });

  it("reads image attachments from their local path and marks the text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-att-"));
    const imgPath = join(dir, "photo.png");
    writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a", "hex"));

    try {
      const { channel, children } = makeChannel();
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "img-guid-1",
        text: "",
        attachments: [{
          filename: "photo.png",
          transfer_name: "photo.png",
          mime_type: "image/png",
          original_path: imgPath,
          total_bytes: 8,
          missing: false,
          is_sticker: false,
        }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      const msg = handler.mock.calls[0][0];
      expect(msg.text).toBe("[Sent an image]");
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0].mediaType).toBe("image/png");
      expect(Buffer.from(msg.images![0].data, "base64").toString("hex")).toBe("89504e470d0a1a0a");
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the converted attachment flavor when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-att-"));
    const convertedPath = join(dir, "photo.png");
    writeFileSync(convertedPath, Buffer.from("cafe", "hex"));

    try {
      const { channel, children } = makeChannel();
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "img-guid-2",
        text: "look",
        attachments: [{
          mime_type: "image/heic",
          original_path: join(dir, "missing.heic"),
          converted_path: convertedPath,
          converted_mime_type: "image/png",
          missing: false,
        }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      const msg = handler.mock.calls[0][0];
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0].mediaType).toBe("image/png");
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts an inbound HEIC attachment (by mime/extension) to JPEG on the group path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-heic-"));
    const heicPath = join(dir, "photo.heic");
    // Minimal HEIC: ftyp box with the `heic` major brand.
    writeFileSync(heicPath, Buffer.from("000000246674797068656963000000006d696631", "hex"));

    try {
      const convertHeic = vi.fn(async (_src: string) => {
        const out = join(dir, "converted.jpg");
        writeFileSync(out, Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"));
        return out;
      });
      const { channel, children } = makeChannel({ config: { convertHeic, imageStoreBaseDir: dir } });
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "heic-guid-1",
        chat_guid: GROUP_GUID,
        is_group: true,
        text: "",
        attachments: [{
          filename: "photo.heic",
          mime_type: "image/heic",
          original_path: heicPath,
          missing: false,
        }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(convertHeic).toHaveBeenCalledWith(heicPath);
      const msg = handler.mock.calls[0][0];
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0].mediaType).toBe("image/jpeg");
      expect(msg.images![0].savedPath).toMatch(/\.jpg$/);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts a HEIC attachment detected only by magic bytes (mislabeled mime, no .heic extension)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-heic-"));
    const srcPath = join(dir, "IMG_0001.jpg"); // wrong extension
    writeFileSync(srcPath, Buffer.from("000000246674797068656963000000006d696631", "hex"));

    try {
      const convertHeic = vi.fn(async (_src: string) => {
        const out = join(dir, "converted.jpg");
        writeFileSync(out, Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"));
        return out;
      });
      // Mime lies ("image/jpeg") and the extension is .jpg; only the ftyp magic
      // bytes reveal it's really HEIC.
      const { channel, children } = makeChannel({ config: { convertHeic, imageStoreBaseDir: dir } });
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "heic-guid-2",
        chat_guid: GROUP_GUID,
        is_group: true,
        text: "",
        attachments: [{ mime_type: "image/jpeg", original_path: srcPath, missing: false }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(convertHeic).toHaveBeenCalledWith(srcPath);
      const msg = handler.mock.calls[0][0];
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0].mediaType).toBe("image/jpeg");
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the original HEIC bytes when conversion fails, without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-heic-"));
    const heicPath = join(dir, "photo.heic");
    const heicBytes = Buffer.from("000000246674797068656963000000006d696631", "hex");
    writeFileSync(heicPath, heicBytes);

    try {
      const convertHeic = vi.fn(async (_src: string) => null); // conversion failed
      const { channel, children } = makeChannel({ config: { convertHeic, imageStoreBaseDir: dir } });
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "heic-guid-3",
        chat_guid: DM_GUID,
        text: "",
        attachments: [{
          filename: "photo.heic",
          mime_type: "image/heic",
          original_path: heicPath,
          missing: false,
        }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(convertHeic).toHaveBeenCalledWith(heicPath);
      const msg = handler.mock.calls[0][0];
      // Attachment is NOT dropped — original HEIC bytes/mime are kept.
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0].mediaType).toBe("image/heic");
      expect(Buffer.from(msg.images![0].data, "base64").equals(heicBytes)).toBe(true);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes non-HEIC images through untouched (no conversion attempted)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-heic-"));
    const pngPath = join(dir, "photo.png");
    writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

    try {
      const convertHeic = vi.fn(async (_src: string) => null);
      const { channel, children } = makeChannel({ config: { convertHeic, imageStoreBaseDir: dir } });
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "png-guid-1",
        text: "",
        attachments: [{ filename: "photo.png", mime_type: "image/png", original_path: pngPath, missing: false }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(convertHeic).not.toHaveBeenCalled();
      const msg = handler.mock.calls[0][0];
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0].mediaType).toBe("image/png");
      expect(Buffer.from(msg.images![0].data, "base64").toString("hex")).toBe("89504e470d0a1a0a");
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips attachments marked missing and still delivers the text", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      guid: "img-guid-3",
      text: "photo coming",
      attachments: [{ mime_type: "image/png", original_path: "/nonexistent.png", missing: true }],
    }));
    await settle();

    const msg = handler.mock.calls[0][0];
    expect(msg.images).toBeUndefined();
    expect(msg.text).toContain("photo coming");
    await channel.stop();
  });

  it("drops empty ghost rows", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "ghost-1", text: "   " }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });

  it("dispatches slash commands with a normalized senderId", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const commandHandler = vi.fn(async () => {});
    channel.onCommand(commandHandler);

    children[0].notifyMessage(inboundMessage({
      guid: "cmd-1",
      text: "/model sonnet",
      sender: "+1 (555) 123-4567",
      sender_name: "Shuai",
    }));
    await settle();

    expect(commandHandler).toHaveBeenCalledWith("model", DM_GUID, "Shuai", "sonnet", "+15551234567");
    await channel.stop();
  });
});

// --- Echo + dedupe -----------------------------------------------------------

describe("imsg echo and replay dedupe", () => {
  it("never dispatches is_from_me rows but records them for substring targeting", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "own-1", text: "our own send", is_from_me: true }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    const recent = channel.recentMessages(DM_GUID);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ id: "own-1", fromMe: true });
    expect(recent[0].senderName).toBeUndefined();
    await channel.stop();
  });

  it("drops a replayed GUID within one process", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "dup-1" }));
    children[0].notifyMessage(inboundMessage({ guid: "dup-1" }));
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    await channel.stop();
  });

  it("drops a replayed GUID across channel restarts via the persistent store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-dedupe-"));
    const dedupeStorePath = join(dir, "seen.json");
    try {
      const first = makeChannel({ config: { dedupeStorePath } });
      await first.channel.start();
      const firstHandler = vi.fn(async () => {});
      first.channel.onMessage(firstHandler);
      first.children[0].notifyMessage(inboundMessage({ guid: "persist-1" }));
      await settle();
      expect(firstHandler).toHaveBeenCalledTimes(1);
      await first.channel.stop();

      const second = makeChannel({ config: { dedupeStorePath } });
      await second.channel.start();
      const secondHandler = vi.fn(async () => {});
      second.channel.onMessage(secondHandler);
      second.children[0].notifyMessage(inboundMessage({ guid: "persist-1" }));
      await settle();
      expect(secondHandler).not.toHaveBeenCalled();
      await second.channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes the watch from the persisted rowid cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-cursor-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const first = makeChannel({ config: { cursorStorePath } });
      await first.channel.start();
      first.channel.onMessage(vi.fn(async () => {}));
      first.children[0].notifyMessage(inboundMessage({ id: 4242, guid: "cursor-1" }));
      await settle();
      await first.channel.stop();

      const second = makeChannel({ config: { cursorStorePath } });
      await second.channel.start();
      const subscribe = second.requests().find((r) => r.method === "watch.subscribe");
      expect(subscribe?.params.since_rowid).toBe(4242);
      await second.channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Inbound tapbacks ---------------------------------------------------------

describe("imsg inbound tapbacks", () => {
  it("surfaces another sender's tapback add with the original excerpt", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "orig-1", text: "pizza tonight?" }));
    children[0].notifyMessage(inboundMessage({
      id: 101,
      guid: "react-1",
      text: "Loved “pizza tonight?”",
      is_reaction: true,
      reaction_type: "love",
      is_reaction_add: true,
      reacted_to_guid: "orig-1",
    }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    // Reaction rows dispatch synchronously while regular rows await
    // attachment loading, so select by id rather than call order.
    const reaction = handler.mock.calls.map((c) => c[0]).find((m) => m.id === "react-1");
    expect(reaction?.text).toBe('[reacting to: "pizza tonight?"] [tapback: love]');
    expect(reaction?.isMentioned).toBe(false);
    await channel.stop();
  });

  it("ignores tapback removals and our own tapbacks", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({
      id: 102, guid: "react-2", is_reaction: true, reaction_type: "like", is_reaction_add: false, reacted_to_guid: "x",
    }));
    children[0].notifyMessage(inboundMessage({
      id: 103, guid: "react-3", is_reaction: true, reaction_type: "like", is_reaction_add: true, is_from_me: true, reacted_to_guid: "x",
    }));
    await settle();

    expect(handler).not.toHaveBeenCalled();
    await channel.stop();
  });
});

// --- Outbound ------------------------------------------------------------------

describe("imsg outbound send", () => {
  it("chunks long text and sends each chunk as a plain send", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const longText = `${"x".repeat(3990)} ${"y".repeat(100)}`;
    await channel.send({ chatId: DM_GUID, text: longText });

    const sends = requests().filter((r) => r.method === "send");
    expect(sends.length).toBeGreaterThan(1);
    for (const s of sends) {
      expect(s.params.chat_guid).toBe(DM_GUID);
      expect((s.params.text as string).length).toBeLessThanOrEqual(4000);
    }
    expect(sends.map((s) => s.params.text).join(" ")).toBe(longText);
    await channel.stop();
  });

  it("threads only the first chunk via send.rich when the bridge is up", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const longText = `${"x".repeat(3990)} ${"y".repeat(100)}`;
    await channel.send({ chatId: DM_GUID, text: longText, replyTo: "guid-target" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all[0].method).toBe("send.rich");
    expect(all[0].params).toMatchObject({ chat_guid: DM_GUID, reply_to: "guid-target", part_index: 0 });
    for (const rest of all.slice(1)) {
      expect(rest.method).toBe("send");
      expect(rest.params).not.toHaveProperty("reply_to");
    }
    await channel.stop();
  });

  it("falls back to a plain send when send.rich fails (bridge hiccup)", async () => {
    const { channel, requests } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send.rich") return child.respondError(req.id, -32603, "Internal error", "bridge not running");
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "threaded!", replyTo: "guid-target" });

    const methods = requests().map((r) => r.method);
    expect(methods).toContain("send.rich");
    expect(methods).toContain("send");
    await channel.stop();
  });

  it("does not use send.rich without the bridge", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "plain", replyTo: "guid-target" });

    expect(requests().map((r) => r.method)).not.toContain("send.rich");
    await channel.stop();
  });

  it("sends the expressive-send effect via send.rich on the first chunk only", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const longText = `${"x".repeat(3990)} ${"y".repeat(100)}`;
    await channel.send({ chatId: DM_GUID, text: longText, effect: "confetti" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all[0].method).toBe("send.rich");
    expect(all[0].params).toMatchObject({ chat_guid: DM_GUID, effect: "confetti", part_index: 0 });
    for (const rest of all.slice(1)) {
      expect(rest.method).toBe("send");
      expect(rest.params).not.toHaveProperty("effect");
    }
    expect(all.map((s) => s.params.text).join(" ")).toBe(longText);
    await channel.stop();
  });

  it("combines effect and reply threading in a single send.rich", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "boom", replyTo: "guid-target", effect: "impact" });

    const rich = requests().filter((r) => r.method === "send.rich");
    expect(rich).toHaveLength(1);
    expect(rich[0].params).toMatchObject({ chat_guid: DM_GUID, text: "boom", reply_to: "guid-target", effect: "impact" });
    await channel.stop();
  });

  it("drops the effect without the bridge — plain send, no marker in text", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "congrats!", effect: "confetti" });

    const sends = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(sends).toHaveLength(1);
    expect(sends[0].method).toBe("send");
    expect(sends[0].params.text).toBe("congrats!");
    expect(sends[0].params).not.toHaveProperty("effect");
    expect(JSON.stringify(sends[0].params)).not.toContain("confetti");
    await channel.stop();
  });

  it("falls back to a plain send when send.rich rejects an effect", async () => {
    const { channel, requests } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send.rich") return child.respondError(req.id, -32603, "Internal error", "bridge not running");
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "congrats!", effect: "confetti" });

    const methods = requests().map((r) => r.method);
    expect(methods).toContain("send.rich");
    expect(methods).toContain("send");
    const plain = requests().filter((r) => r.method === "send");
    expect(plain[0].params.text).toBe("congrats!");
    await channel.stop();
  });

  it("sends a bare-URL message as a rich link when the bridge supports it", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_RICHLINK });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "https://example.com/post" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all).toHaveLength(1);
    expect(all[0].method).toBe("send.rich");
    // url mode accepts ONLY the chat target and the url — no text/part_index.
    expect(all[0].params).toEqual({ chat_guid: DM_GUID, url: "https://example.com/post" });
    await channel.stop();
  });

  it("keeps bare URLs as plain sends when the bridge lacks rich-link selectors", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "https://example.com/post" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all).toHaveLength(1);
    expect(all[0].method).toBe("send");
    expect(all[0].params.text).toBe("https://example.com/post");
    await channel.stop();
  });

  it("falls back to a plain send when the rich link send fails", async () => {
    const { channel, requests } = makeChannel({
      caps: CAPS_RICHLINK,
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send.rich") return child.respondError(req.id, -32602, "Invalid params", "Invalid rich-link URL");
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "https://example.com/post" });

    const plain = requests().filter((r) => r.method === "send");
    expect(plain).toHaveLength(1);
    expect(plain[0].params.text).toBe("https://example.com/post");
    await channel.stop();
  });

  it("does not rich-link a URL embedded in prose", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_RICHLINK });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "check this out https://example.com/post" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all).toHaveLength(1);
    expect(all[0].method).toBe("send");
    await channel.stop();
  });

  it("does not fall back to a plain send when a rich send fails ambiguously (no double-send)", async () => {
    const { channel, requests } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send.rich") {
          // Child dies with the request in flight: no error response exists
          // to prove the message was NOT dispatched before the crash, so a
          // fallback plain send could deliver the text twice.
          child.emit("exit", 1, null);
          return;
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await expect(channel.send({ chatId: DM_GUID, text: "congrats!", effect: "confetti" })).rejects.toThrow(/send\.rich/);
    expect(requests().filter((r) => r.method === "send")).toHaveLength(0);
    await channel.stop();
  });

  it("does not fall back when a rich link send fails ambiguously (no double-send)", async () => {
    const { channel, requests } = makeChannel({
      caps: CAPS_RICHLINK,
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send.rich") {
          child.emit("exit", 1, null);
          return;
        }
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await expect(channel.send({ chatId: DM_GUID, text: "https://example.com/post" })).rejects.toThrow(/send\.rich/);
    expect(requests().filter((r) => r.method === "send")).toHaveLength(0);
    await channel.stop();
  });

  it("heals the rich-link selector snapshot via on-demand re-probe while the bridge stays up", async () => {
    // advanced_features is true the WHOLE time — only the selectors change
    // (Messages relaunched with a newer bridge dylib). This is the state the
    // default reprobe gate early-returns on; the url path opts in.
    let probes = 0;
    const { channel, requests } = makeChannel({
      config: {
        probeCapabilities: async () => (++probes === 1 ? CAPS_FULL : CAPS_RICHLINK),
        capabilityReprobeMinIntervalMs: 0,
      },
    });
    await channel.start();

    // Pre-relaunch snapshot: bare URL goes plain and kicks a background probe.
    await channel.send({ chatId: DM_GUID, text: "https://example.com/a" });
    await settle();

    await channel.send({ chatId: DM_GUID, text: "https://example.com/b" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all.map((r) => r.method)).toEqual(["send", "send.rich"]);
    expect(all[1].params).toEqual({ chat_guid: DM_GUID, url: "https://example.com/b" });
    expect(probes).toBeGreaterThanOrEqual(2);
    await channel.stop();
  });

  it("prefers the reply/effect rich send over a rich link for a bare-URL reply", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_RICHLINK });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "https://example.com/post", replyTo: "guid-target" });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all).toHaveLength(1);
    expect(all[0].method).toBe("send.rich");
    expect(all[0].params).toMatchObject({ text: "https://example.com/post", reply_to: "guid-target" });
    expect(all[0].params).not.toHaveProperty("url");
    await channel.stop();
  });

  it("threads only the first shipped block of a streamed group reply", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const stream = channel.createStreamingMessage(GROUP_GUID, "guid-trigger");
    stream.update("first block");
    await stream.commitBlock();
    stream.update("second block");
    await stream.finish();

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all).toHaveLength(2);
    expect(all[0].method).toBe("send.rich");
    expect(all[0].params).toMatchObject({ text: "first block", reply_to: "guid-trigger" });
    expect(all[1].method).toBe("send");
    expect(all[1].params.text).toBe("second block");
    await channel.stop();
  });

  it("drops a whole streamed block whose trailing line is a bare NO_REPLY", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const stream = channel.createStreamingMessage(DM_GUID);
    stream.update("archived the logs, nothing urgent\nNO_REPLY");
    await stream.finish();

    expect(requests().filter((r) => r.method === "send" || r.method === "send.rich")).toHaveLength(0);
    await channel.stop();
  });

  it("ships a streamed block that merely mentions NO_REPLY inline", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const stream = channel.createStreamingMessage(DM_GUID);
    stream.update("the literal token is NO_REPLY, for reference");
    await stream.finish();

    const sends = requests().filter((r) => r.method === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].params.text).toBe("the literal token is NO_REPLY, for reference");
    await channel.stop();
  });

  it("still ships earlier real blocks when a later block is NO_REPLY-only", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const stream = channel.createStreamingMessage(DM_GUID);
    stream.update("real block");
    await stream.commitBlock();
    stream.update("NO_REPLY");
    await stream.finish();

    const sends = requests().filter((r) => r.method === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].params.text).toBe("real block");
    await channel.stop();
  });

  it("sends a photo via the send file param with a separate caption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-photo-"));
    const photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake");
    try {
      const { channel, requests } = makeChannel();
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "look at this", photo: photoPath });

      const sends = requests().filter((r) => r.method === "send");
      expect(sends[0].params).toMatchObject({ chat_guid: DM_GUID, file: photoPath });
      expect(sends[1].params).toMatchObject({ chat_guid: DM_GUID, text: "look at this" });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records outbound sends that return a GUID for substring targeting", async () => {
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send") return child.respond(req.id, { ok: true, id: 42, guid: "sent-guid-1" });
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "hello" });

    const recent = channel.recentMessages(DM_GUID);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ id: "sent-guid-1", text: "hello", fromMe: true });
    await channel.stop();
  });
});

// --- Sticker sends (#259) --------------------------------------------------------

describe("imsg sticker sends", () => {
  const withStickerFile = async (fn: (stickerPath: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-sticker-"));
    const stickerPath = join(dir, "dog-big-nose.jpg");
    writeFileSync(stickerPath, "fake-jpeg-bytes");
    try {
      await fn(stickerPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("routes a path-shaped sticker value to send.sticker when the bridge supports it", async () => {
    await withStickerFile(async (stickerPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const all = requests().filter((r) => r.method === "send" || r.method === "send.sticker");
      expect(all).toHaveLength(1);
      expect(all[0].method).toBe("send.sticker");
      // Standalone sticker: exactly the chat target and the file — no
      // attach_to/part_index (attaching to a message is deliberately unwired).
      expect(all[0].params).toEqual({ chat_guid: DM_GUID, file: stickerPath });
      await channel.stop();
    });
  });

  it("expands a leading ~ before the existence check and the RPC", async () => {
    const name = `.tomo-imsg-sticker-test-${process.pid}-${Date.now()}.jpg`;
    const absolute = join(homedir(), name);
    writeFileSync(absolute, "fake-jpeg-bytes");
    try {
      const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "", sticker: `~/${name}` });

      const stickers = requests().filter((r) => r.method === "send.sticker");
      expect(stickers).toHaveLength(1);
      expect(stickers[0].params.file).toBe(absolute);
      await channel.stop();
    } finally {
      rmSync(absolute, { force: true });
    }
  });

  it("drops a Telegram file_id-shaped sticker value (channel-bound id)", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "", sticker: "CAACAgIAAxkBAAIBOWX1abc123" });

    expect(requests().filter((r) => r.method === "send" || r.method === "send.sticker")).toHaveLength(0);
    await channel.stop();
  });

  it("sends nothing when the sticker path does not exist", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "", sticker: "/nonexistent/sticker.png" });

    expect(requests().filter((r) => r.method === "send" || r.method === "send.sticker")).toHaveLength(0);
    await channel.stop();
  });

  it("falls back to a plain attachment send when the bridge lacks the sticker surface", async () => {
    await withStickerFile(async (stickerPath) => {
      // CAPS_FULL: bridge up, but no send.sticker RPC / stickerSend selector
      // (the currently-injected pre-0.13 bridge on a live cutover machine).
      const { channel, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const all = requests().filter((r) => r.method === "send" || r.method === "send.sticker");
      expect(all).toHaveLength(1);
      expect(all[0].method).toBe("send");
      expect(all[0].params).toEqual({ chat_guid: DM_GUID, file: stickerPath });
      await channel.stop();
    });
  });

  it("heals the sticker selector snapshot via on-demand re-probe while the bridge stays up", async () => {
    // advanced_features is true the WHOLE time — only the sticker surface
    // appears (Messages relaunched with the 0.13 bridge dylib). The default
    // reprobe gate early-returns on a live bridge; the sticker path opts in
    // with evenIfBridged, mirroring rich links.
    await withStickerFile(async (stickerPath) => {
      let probes = 0;
      const { channel, requests } = makeChannel({
        config: {
          probeCapabilities: async () => (++probes === 1 ? CAPS_FULL : CAPS_STICKER),
          capabilityReprobeMinIntervalMs: 0,
        },
      });
      await channel.start();

      // Pre-relaunch snapshot: sticker degrades to a plain attachment and
      // kicks a background probe.
      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });
      await settle();

      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const all = requests().filter((r) => r.method === "send" || r.method === "send.sticker");
      expect(all.map((r) => r.method)).toEqual(["send", "send.sticker"]);
      expect(probes).toBeGreaterThanOrEqual(2);
      await channel.stop();
    });
  });

  it("falls back to a plain attachment send when send.sticker is refused", async () => {
    await withStickerFile(async (stickerPath) => {
      const { channel, requests } = makeChannel({
        caps: CAPS_STICKER,
        responder: (req, child) => {
          if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
          if (req.method === "send.sticker") return child.respondError(req.id, -32602, "Invalid params", "Sticker image must be between 1 byte and 512000 bytes");
          child.respond(req.id, { ok: true });
        },
      });
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const methods = requests().map((r) => r.method);
      expect(methods).toContain("send.sticker");
      const plain = requests().filter((r) => r.method === "send");
      expect(plain).toHaveLength(1);
      expect(plain[0].params).toEqual({ chat_guid: DM_GUID, file: stickerPath });
      await channel.stop();
    });
  });

  it("does not fall back when send.sticker fails ambiguously (no double-send)", async () => {
    await withStickerFile(async (stickerPath) => {
      const { channel, requests } = makeChannel({
        caps: CAPS_STICKER,
        responder: (req, child) => {
          if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
          if (req.method === "send.sticker") {
            // Child dies with the request in flight: no error response proves
            // the sticker was NOT dispatched, so a fallback could deliver it twice.
            child.emit("exit", 1, null);
            return;
          }
          child.respond(req.id, { ok: true });
        },
      });
      await channel.start();

      await expect(channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath })).rejects.toThrow(/send\.sticker/);
      expect(requests().filter((r) => r.method === "send")).toHaveLength(0);
      await channel.stop();
    });
  });

  it("records a native sticker send for substring targeting (unsend)", async () => {
    await withStickerFile(async (stickerPath) => {
      const { channel } = makeChannel({
        caps: CAPS_STICKER,
        responder: (req, child) => {
          if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
          if (req.method === "send.sticker") return child.respond(req.id, { ok: true, guid: "sticker-guid-1" });
          child.respond(req.id, { ok: true });
        },
      });
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const recent = channel.recentMessages(DM_GUID);
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({ id: "sticker-guid-1", text: "[sticker: dog-big-nose.jpg]", fromMe: true });
      await channel.stop();
    });
  });
});

// --- Tapback / unsend / edit -----------------------------------------------------

describe("imsg tapback, unsend, and edit", () => {
  it("sends a targeted tapback over RPC with the `kind` param (NOT `reaction`)", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.reactToMessage(DM_GUID, "target-guid", "love");

    const tapback = requests().find((r) => r.method === "tapback");
    // imsg's shipped tapback RPC honors `kind` (the CLI --kind flag); a
    // `reaction` field is silently ignored → defaults to 👍. Assert the exact
    // param name so a rename back to `reaction` regresses loudly.
    expect(tapback?.params).toEqual({
      chat_guid: DM_GUID,
      message_guid: "target-guid",
      kind: "love",
      remove: false,
      part_index: 0,
    });
    expect(tapback?.params).not.toHaveProperty("reaction");
    await channel.stop();
  });

  it("removes a tapback with remove: true", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.reactToMessage(DM_GUID, "target-guid", "like", true);

    expect(requests().find((r) => r.method === "tapback")?.params).toMatchObject({ kind: "like", remove: true });
    await channel.stop();
  });

  it("unsends via message.unsend and drops the cached row", async () => {
    const { channel, children, requests } = makeChannel();
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));

    children[0].notifyMessage(inboundMessage({ guid: "mine-1", text: "oops wrong chat", is_from_me: true }));
    await settle();
    expect(channel.recentMessages(DM_GUID)).toHaveLength(1);

    await channel.unsendMessage(DM_GUID, "mine-1");

    expect(requests().find((r) => r.method === "message.unsend")?.params).toEqual({
      chat_guid: DM_GUID,
      message_guid: "mine-1",
      part_index: 0,
    });
    expect(channel.recentMessages(DM_GUID)).toHaveLength(0);
    await channel.stop();
  });

  it("refuses edit with a clean error when the macOS edit selectors are gone", async () => {
    // Ground truth for macOS 26.5: editMessageItem and editMessage both
    // probed unavailable — calling message.edit blindly is what #227 was.
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    await expect(channel.editMessage(DM_GUID, "mine-1", "fixed text"))
      .rejects.toThrow(/editing is unsupported on this macOS/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");
    await channel.stop();
  });

  it("edits via message.edit when a selector probe confirms support", async () => {
    const caps: ImsgCapabilities = {
      ...CAPS_FULL,
      selectors: { ...CAPS_FULL.selectors, editMessageItem: true },
    };
    const { channel, requests } = makeChannel({ caps });
    await channel.start();

    await channel.editMessage(DM_GUID, "mine-1", "fixed text");

    expect(requests().find((r) => r.method === "message.edit")?.params).toEqual({
      chat_guid: DM_GUID,
      message_guid: "mine-1",
      text: "fixed text",
      backwards_compatibility_message: "Edited to: fixed text",
      part_index: 0,
    });
    await channel.stop();
  });

  it("rejects empty edited text without calling the API", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await expect(channel.editMessage(DM_GUID, "mine-1", "  ")).rejects.toThrow(/cannot be empty/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");
    await channel.stop();
  });
});

// --- Group rename / typing ----------------------------------------------------

describe("imsg group rename and typing", () => {
  it("renames a group via group.rename", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.setChatTitle(GROUP_GUID, "New Title");

    expect(requests().find((r) => r.method === "group.rename")?.params).toEqual({
      chat_guid: GROUP_GUID,
      name: "New Title",
    });
    await channel.stop();
  });

  it("starts typing over RPC and always stops it on cleanup", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();
    await settle();

    const typing = requests().filter((r) => r.method === "typing");
    expect(typing.length).toBeGreaterThanOrEqual(2);
    expect(typing[0].params).toMatchObject({ chat_guid: DM_GUID, typing: true });
    expect(typing[typing.length - 1].params).toMatchObject({ chat_guid: DM_GUID, typing: false });
    await channel.stop();
  });

  it("degrades typing to a no-op when the bridge lacks typing indicators", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();

    expect(requests().map((r) => r.method)).not.toContain("typing");
    await channel.stop();
  });
});

// --- Mark read ------------------------------------------------------------------

describe("imsg mark-as-read", () => {
  it("marks the chat read after an inbound message when read receipts work", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));

    children[0].notifyMessage(inboundMessage());
    await settle();

    expect(requests().find((r) => r.method === "read")?.params).toEqual({ chat_guid: DM_GUID });
    await channel.stop();
  });

  it("skips the read call without the bridge", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));

    children[0].notifyMessage(inboundMessage());
    await settle();

    expect(requests().map((r) => r.method)).not.toContain("read");
    await channel.stop();
  });
});

// --- RPC param-name contract (guards against field-name drift vs the imsg CLI) ---
// Unit-test mocks don't know imsg's real field names, so a rename (e.g. the
// tapback `reaction`→`kind` dogfood bug) can pass tests while silently
// misbehaving on-device. These assert the EXACT param key set of every outbound
// RPC against the verified v0.12.3 imsg handler contract, so drift fails loudly.

describe("imsg outbound RPC param-name contract", () => {
  const editSelectorCaps: ImsgCapabilities = {
    ...CAPS_FULL,
    rpcMethods: new Set([...CAPS_FULL.rpcMethods, "message.edit"]),
    selectors: { ...CAPS_FULL.selectors, editMessageItem: true },
  };
  const keysOf = (requests: () => RpcRequest[], method: string) =>
    Object.keys(requests().find((r) => r.method === method)?.params ?? {}).sort();

  it("send (plain text) → chat_guid, text", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    await channel.send({ chatId: DM_GUID, text: "hi" });
    expect(keysOf(requests, "send")).toEqual(["chat_guid", "text"]);
    await channel.stop();
  });

  it("send (attachment) → chat_guid, file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-contract-"));
    const photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "x");
    try {
      const { channel, requests } = makeChannel();
      await channel.start();
      await channel.send({ chatId: DM_GUID, photo: photoPath });
      expect(keysOf(requests, "send")).toEqual(["chat_guid", "file"]);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("send.sticker → chat_guid, file", async () => {
    // Verified against imsg v0.13.4 RPCServer+StickerHandlers.swift:
    // supported params are chat_id|chat_identifier|chat_guid, file, attach_to,
    // part_index; we send exactly chat_guid + file (standalone sticker).
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-contract-"));
    const stickerPath = join(dir, "sticker.png");
    writeFileSync(stickerPath, "x");
    try {
      const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
      await channel.start();
      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });
      expect(keysOf(requests, "send.sticker")).toEqual(["chat_guid", "file"]);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("send.rich (threaded reply) → chat_guid, part_index, reply_to, text", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    await channel.send({ chatId: DM_GUID, text: "hi", replyTo: "guid-target" });
    expect(keysOf(requests, "send.rich")).toEqual(["chat_guid", "part_index", "reply_to", "text"]);
    await channel.stop();
  });

  it("tapback → chat_guid, kind, message_guid, part_index, remove", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    await channel.reactToMessage(DM_GUID, "m-1", "love");
    expect(keysOf(requests, "tapback")).toEqual(["chat_guid", "kind", "message_guid", "part_index", "remove"]);
    await channel.stop();
  });

  it("typing → chat_guid, typing", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    const stop = channel.startTyping(DM_GUID);
    await settle();
    await stop();
    expect(keysOf(requests, "typing")).toEqual(["chat_guid", "typing"]);
    await channel.stop();
  });

  it("read → chat_guid", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));
    children[0].notifyMessage(inboundMessage());
    await vi.waitFor(() => expect(requests().some((r) => r.method === "read")).toBe(true));
    expect(keysOf(requests, "read")).toEqual(["chat_guid"]);
    await channel.stop();
  });

  it("message.unsend → chat_guid, message_guid, part_index", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    await channel.unsendMessage(DM_GUID, "m-1");
    expect(keysOf(requests, "message.unsend")).toEqual(["chat_guid", "message_guid", "part_index"]);
    await channel.stop();
  });

  it("message.edit → backwards_compatibility_message, chat_guid, message_guid, part_index, text", async () => {
    const { channel, requests } = makeChannel({ caps: editSelectorCaps });
    await channel.start();
    await channel.editMessage(DM_GUID, "m-1", "fixed");
    expect(keysOf(requests, "message.edit")).toEqual([
      "backwards_compatibility_message", "chat_guid", "message_guid", "part_index", "text",
    ]);
    await channel.stop();
  });

  it("group.rename → chat_guid, name", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    await channel.setChatTitle(GROUP_GUID, "New Title");
    expect(keysOf(requests, "group.rename")).toEqual(["chat_guid", "name"]);
    await channel.stop();
  });

  it("watch.subscribe → attachments, convert_attachments, include_reactions (+ since_rowid when resuming)", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    expect(keysOf(requests, "watch.subscribe")).toEqual(["attachments", "convert_attachments", "include_reactions"]);
    await channel.stop();
  });
});

// --- Child lifecycle --------------------------------------------------------------

describe("imsg rpc child lifecycle", () => {
  it("restarts the child with backoff after a crash and resubscribes from the cursor", async () => {
    vi.useFakeTimers();
    const { channel, children, spawnFn } = makeChannel({ config: { restartDelaysMs: [1_000, 5_000] } });
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));
    expect(spawnFn).toHaveBeenCalledTimes(1);

    children[0].notifyMessage(inboundMessage({ id: 777, guid: "pre-crash" }));
    await settle();

    children[0].emit("exit", 1, null);
    expect(spawnFn).toHaveBeenCalledTimes(1); // waits out the backoff first

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(2);

    // The replacement child resubscribes strictly after the last seen rowid.
    const resubscribe = JSON.parse(children[1].stdin.lines[0]) as RpcRequest;
    expect(resubscribe.method).toBe("watch.subscribe");
    expect(resubscribe.params.since_rowid).toBe(777);

    // The new child works: inbound flows again.
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);
    children[1].notifyMessage(inboundMessage({ id: 778, guid: "post-crash" }));
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
    const { channel, children, spawnFn } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        // never answer send — leave it in flight
      },
    });
    await channel.start();

    const inFlight = channel.send({ chatId: DM_GUID, text: "hi" });
    const rejection = expect(inFlight).rejects.toThrow(/imsg rpc child exited/);
    await settle();
    children[0].emit("exit", 0, null);
    await rejection;

    await channel.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnFn).toHaveBeenCalledTimes(1);
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
    const child0 = children[0];

    // The next write (a send) backpressures — write() returns false and its
    // chain link parks on 'drain' (which will never fire for this child).
    child0.stdin.backpressureWrites = 1;
    void channel.send({ chatId: DM_GUID, text: "stuck" }).catch(() => {});
    await settle();
    expect(child0.stdin.listenerCount("drain")).toBeGreaterThan(0);

    // The child dies before draining. The parked write must not wedge the
    // global write chain, or the restarted subscribe would queue behind it.
    child0.emit("exit", 1, null);
    await settle();
    expect(child0.stdin.listenerCount("drain")).toBe(0); // parked wait released

    // Restart: the new child's watch.subscribe actually goes out.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    await vi.waitFor(() => {
      const sub = children[1].stdin.lines.map((l) => JSON.parse(l) as RpcRequest).find((r) => r.method === "watch.subscribe");
      expect(sub).toBeDefined();
    });
    await channel.stop();
  });

  it("ignores buffered stdout from an old killed child after restart (round-3 #3)", async () => {
    vi.useFakeTimers();
    const { channel, children } = makeChannel({ config: { restartDelaysMs: [1_000] } });
    await channel.start();
    const handler = vi.fn(async () => {});
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
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0].id).toBe("live-1");
    await channel.stop();
  });
});

// --- recentMessages addressing ---------------------------------------------------

describe("imsg recent-message cache addressing", () => {
  it("resolves a bare DM handle to its chat-GUID ring, but never a group", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));

    children[0].notifyMessage(inboundMessage({ guid: "g-dm", text: "direct message" }));
    children[0].notifyMessage(inboundMessage({
      guid: "g-group", text: "group message", chat_guid: GROUP_GUID, is_group: true,
    }));
    // Rows process through a FIFO chain, so wait for the second to land.
    await vi.waitFor(() => expect(channel.recentMessages(GROUP_GUID)).toHaveLength(1));

    expect(channel.recentMessages("+1 (555) 123-4567").map((m) => m.id)).toEqual(["g-dm"]);
    expect(channel.recentMessages("+15551234567").map((m) => m.id)).toEqual(["g-dm"]);
    expect(channel.recentMessages(GROUP_GUID).map((m) => m.id)).toEqual(["g-group"]);
    expect(channel.recentMessages("a70f2f5b3ea847759d38c0b8e3cba57d")).toEqual([]);
    await channel.stop();
  });
});

// --- Session-key passthrough (Codex adjudication: no normalization) --------------

describe("imsg session-key passthrough", () => {
  it("emits chat_guid verbatim so keys match the on-disk any-format sessions", async () => {
    const { channel, children } = makeChannel();
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    // DMs on macOS 26 are stored as any;-;+E164; groups as any;+;<hex>.
    // These map to ~/.tomo/data/sessions/imessage_any_-__<E164>.jsonl and
    // imessage_any___<hex>.jsonl — BlueBubbles reported the identical GUIDs,
    // so passthrough (no normalization) keeps existing session keys valid.
    children[0].notifyMessage(inboundMessage({ guid: "dm-1", text: "hi", chat_guid: "any;-;+15551234567" }));
    children[0].notifyMessage(inboundMessage({ guid: "grp-1", text: "yo", chat_guid: "any;+;a70f2f5b3ea847759d38c0b8e3cba57d", is_group: true }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    const byId = Object.fromEntries(handler.mock.calls.map((c) => [c[0].id, c[0]]));
    expect(byId["dm-1"].chatId).toBe("any;-;+15551234567");
    expect(byId["dm-1"].isGroup).toBe(false);
    expect(byId["grp-1"].chatId).toBe("any;+;a70f2f5b3ea847759d38c0b8e3cba57d");
    expect(byId["grp-1"].isGroup).toBe(true);
    await channel.stop();
  });
});

// --- Satellite (iMessageLite) detection via chat.db service lookup ---------------

describe("imsg satellite detection", () => {
  const makeLookup = (services: Record<string, string>): { lookup: ServiceLookup; spy: ReturnType<typeof vi.fn> } => {
    const spy = vi.fn((guid: string) => services[guid]);
    return { lookup: { serviceForGuid: spy, close: () => {} }, spy };
  };

  it("prefixes the satellite marker when message.service is iMessageLite", async () => {
    const { lookup } = makeLookup({ "sat-1": "iMessageLite" });
    const { channel, children } = makeChannel({ config: { serviceLookup: lookup } });
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "sat-1", text: "we are off-grid" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(handler.mock.calls[0][0].text).toBe(`${SATELLITE_MARKER} we are off-grid`);
    await channel.stop();
  });

  it("does not tag standard iMessage rows", async () => {
    const { lookup } = makeLookup({ "plain-1": "iMessage" });
    const { channel, children } = makeChannel({ config: { serviceLookup: lookup } });
    await channel.start();
    const handler = vi.fn(async () => {});
    channel.onMessage(handler);

    children[0].notifyMessage(inboundMessage({ guid: "plain-1", text: "normal message" }));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(handler.mock.calls[0][0].text).toBe("normal message");
    await channel.stop();
  });

  it("skips the sqlite lookup entirely for attachment-only rows (no text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-sat-"));
    const imgPath = join(dir, "photo.png");
    writeFileSync(imgPath, Buffer.from("89504e470d0a1a0a", "hex"));
    try {
      const { lookup, spy } = makeLookup({});
      const { channel, children } = makeChannel({ config: { serviceLookup: lookup } });
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({
        guid: "att-only-1",
        text: "",
        attachments: [{ mime_type: "image/png", original_path: imgPath, total_bytes: 8, missing: false }],
      }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(spy).not.toHaveBeenCalled();
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- At-least-once cursor / GUID ordering (Codex HIGH #1) ------------------------

describe("imsg at-least-once persist ordering", () => {
  it("advances the cursor and records the GUID only AFTER a successful dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-atleastonce-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      const handler = vi.fn(async () => {});
      channel.onMessage(handler);

      children[0].notifyMessage(inboundMessage({ id: 900, guid: "ok-1", text: "delivered" }));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      // A replay of the same GUID is now dropped (recorded after dispatch).
      children[0].notifyMessage(inboundMessage({ id: 900, guid: "ok-1", text: "delivered" }));
      await settle();
      expect(handler).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => {
        expect(existsSync(cursorStorePath)).toBe(true);
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(900);
      });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT advance the cursor when dispatch throws, so the row replays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-replay-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      // Succeeds for row 400, throws for row 500.
      channel.onMessage(async (m) => { if (m.id === "throws-1") throw new Error("boom"); });

      children[0].notifyMessage(inboundMessage({ id: 400, guid: "good-1", text: "ok" }));
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "throws-1", text: "will throw" }));
      // Cursor commits to 400 (the last successful row) and never advances to 500.
      await vi.waitFor(() => {
        expect(existsSync(cursorStorePath)).toBe(true);
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      });
      await settle();
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);

      // A restart therefore resubscribes from 400 — the throwing row replays.
      await channel.stop();
      const second = makeChannel({ config: { cursorStorePath } });
      await second.channel.start();
      const resubscribe = second.requests().find((r) => r.method === "watch.subscribe");
      expect(resubscribe?.params.since_rowid).toBe(400);
      await second.channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT let a LATER row commit the cursor past a failed row (round-2 #1)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-gap-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      // Long backoff so the gap-recovery restart doesn't fire during the test.
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [60_000] } });
      await channel.start();
      const seen: string[] = [];
      channel.onMessage(async (m) => {
        if (m.id === "throws-1") throw new Error("boom");
        seen.push(m.id);
      });

      children[0].notifyMessage(inboundMessage({ id: 400, guid: "good-1", text: "ok" }));
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "throws-1", text: "will throw" }));
      // A later row queued behind the failure — it must not commit past 500.
      children[0].notifyMessage(inboundMessage({ id: 600, guid: "later-1", text: "after the gap" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      });
      await settle();

      // Cursor stays at 400 (never 500, never 600) and the later row is not
      // delivered out of order (the chain was halted for gap recovery).
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      expect(seen).toEqual(["good-1"]);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not wedge the cursor floor when a row WITHOUT a rowid fails to dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-norowid-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath } });
      await channel.start();
      channel.onMessage(async (m) => { if (m.id === "no-rowid") throw new Error("boom"); });

      // A malformed row with no numeric rowid (parses to 0) whose dispatch
      // throws can't be replayed by since_rowid. Flooring at 0 would block
      // every future cursor commit forever — instead the failure is logged,
      // the child stays up, and a later good row still commits.
      children[0].notifyMessage(inboundMessage({ id: undefined, guid: "no-rowid", text: "will throw" }));
      children[0].notifyMessage(inboundMessage({ id: 700, guid: "good-after-norowid", text: "ok" }));
      await vi.waitFor(() => {
        expect(existsSync(cursorStorePath)).toBe(true);
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(700);
      });
      expect(children[0].killed).toBe(false);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advanceCursor refuses to skip a known-failed lower rowid, then clears on replay", () => {
    const { channel } = makeChannel();
    const internals = channel as unknown as {
      lastRowId: number;
      failedRowId: number | null;
      advanceCursor(rowId: number): void;
    };
    internals.lastRowId = 100;
    internals.failedRowId = 200;

    internals.advanceCursor(300); // past the gap → refused
    expect(internals.lastRowId).toBe(100);
    expect(internals.failedRowId).toBe(200);

    internals.advanceCursor(150); // before the gap → allowed
    expect(internals.lastRowId).toBe(150);
    expect(internals.failedRowId).toBe(200);

    internals.advanceCursor(200); // reaching the failed row (successful replay) → clears + advances
    expect(internals.lastRowId).toBe(200);
    expect(internals.failedRowId).toBeNull();

    internals.advanceCursor(300); // gap closed → normal advance resumes
    expect(internals.lastRowId).toBe(300);
  });

  it("halts on a failing COMMAND row so a later row can't advance past it (round-3 #2)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-cmdgap-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [60_000] } });
      await channel.start();
      const seen: string[] = [];
      channel.onMessage(async (m) => { seen.push(m.id); });
      // A slash-command handler that throws.
      channel.onCommand(async (command) => { if (command === "model") throw new Error("cmd boom"); });

      children[0].notifyMessage(inboundMessage({ id: 400, guid: "good-1", text: "hi" }));
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "cmd-1", text: "/model sonnet" }));
      // A later real row queued behind the failing command.
      children[0].notifyMessage(inboundMessage({ id: 600, guid: "later-1", text: "after cmd" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      });
      await settle();

      // The failing command row (500) never lets the cursor advance to 600.
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(400);
      expect(seen).toEqual(["good-1"]); // "later-1" not delivered out of order
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a STALE-generation row failure that rejects after replay advanced the cursor (round-4 #1)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-stalegen-"));
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [1_000] } });
      await channel.start();

      const seen: string[] = [];
      let gateReject: ((e: Error) => void) | null = null;
      let allowReplay = false;
      channel.onMessage(async (m) => {
        if (m.id === "row-500" && !allowReplay) {
          // The OLD-generation delivery hangs until we reject it later.
          await new Promise<void>((_, rej) => { gateReject = rej; });
          return;
        }
        seen.push(m.id);
      });

      // Old generation: row 500 arrives and hangs mid-dispatch.
      children[0].notifyMessage(inboundMessage({ id: 500, guid: "row-500", text: "row 500" }));
      await vi.waitFor(() => expect(gateReject).not.toBeNull());

      // The child restarts (generation bump). The new child replays 500 + 600
      // successfully, advancing the committed cursor to 600.
      allowReplay = true;
      children[0].emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
      children[1].notifyMessage(inboundMessage({ id: 500, guid: "row-500", text: "row 500" }));
      children[1].notifyMessage(inboundMessage({ id: 600, guid: "row-600", text: "row 600" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      });

      // NOW the OLD row 500 finally rejects. Because its generation is stale, it
      // must be a no-op: no floor, no kill, no cursor wedge.
      const childCountBefore = children.length;
      gateReject!(new Error("stale boom"));
      await settle();

      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      expect((channel as unknown as { failedRowId: number | null }).failedRowId).toBeNull();
      expect(children).toHaveLength(childCountBefore); // no extra restart from the stale failure

      // The cursor keeps advancing — not wedged.
      children[1].notifyMessage(inboundMessage({ id: 700, guid: "row-700", text: "row 700" }));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(700);
      });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT dispatch a stale-generation row that blocked in attachment load (round-5)", async () => {
    // Real timers: the row blocks on a real readFile of a FIFO (no fake-timer
    // control over that IO), and restart backoff is tiny.
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-r5-"));
    const fifoPath = join(dir, "blocking.png");
    execFileSync("mkfifo", [fifoPath]);
    const normalPath = join(dir, "replay.png");
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(normalPath, pngBytes);
    const cursorStorePath = join(dir, "cursor.json");
    try {
      const { channel, children } = makeChannel({ config: { cursorStorePath, restartDelaysMs: [10] } });
      await channel.start();
      const seen: string[] = [];
      channel.onMessage(async (m) => { seen.push(m.id); });

      // Old generation: row 500 carries a FIFO attachment, so loadAttachments
      // blocks on readFile BEFORE the dispatch side effect.
      children[0].notifyMessage(inboundMessage({
        id: 500, guid: "row-500", text: "with photo",
        attachments: [{ mime_type: "image/png", original_path: fifoPath, total_bytes: 8, missing: false }],
      }));
      await new Promise((r) => setTimeout(r, 60));
      expect(seen).toEqual([]); // still blocked in attachment load — not delivered

      // The child restarts; the replacement generation replays 500 (with a
      // NORMAL file) + 600 and delivers them exactly once, in order.
      children[0].emit("exit", 1, null);
      await vi.waitFor(() => expect(children).toHaveLength(2));
      children[1].notifyMessage(inboundMessage({
        id: 500, guid: "row-500", text: "with photo",
        attachments: [{ mime_type: "image/png", original_path: normalPath, total_bytes: 8, missing: false }],
      }));
      children[1].notifyMessage(inboundMessage({ id: 600, guid: "row-600", text: "next" }));
      await vi.waitFor(() => expect(seen).toEqual(["row-500", "row-600"]));
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      });

      // Unblock the OLD row's FIFO read → it resumes SUCCESSFULLY, but its
      // generation is now stale, so it must abandon before dispatching.
      const fd = openSync(fifoPath, "w");
      writeSync(fd, pngBytes);
      closeSync(fd);
      await new Promise((r) => setTimeout(r, 80));

      // No duplicate, no out-of-order re-delivery; cursor still at 600.
      expect(seen).toEqual(["row-500", "row-600"]);
      expect(JSON.parse(readFileSync(cursorStorePath, "utf-8")).lastRowId).toBe(600);
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- FIFO watch serialization (Codex MED #3) ------------------------------------

describe("imsg watch FIFO serialization", () => {
  it("processes watch rows strictly in order even when an earlier row blocks", async () => {
    const { channel, children } = makeChannel();
    await channel.start();

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    channel.onMessage(async (m) => {
      order.push(`start:${m.id}`);
      if (m.id === "first") await firstGate;
      order.push(`end:${m.id}`);
    });

    children[0].notifyMessage(inboundMessage({ id: 1, guid: "first", text: "one" }));
    children[0].notifyMessage(inboundMessage({ id: 2, guid: "second", text: "two" }));
    await vi.waitFor(() => expect(order).toContain("start:first"));

    // The second row must not have started while the first is blocked.
    expect(order).toEqual(["start:first"]);

    releaseFirst();
    await vi.waitFor(() => expect(order).toContain("end:second"));
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await channel.stop();
  });
});

// --- stdin backpressure (Codex MED #4) ------------------------------------------

describe("imsg stdin backpressure", () => {
  it("holds the next write until 'drain' when a write signals a full pipe", async () => {
    // Hold send responses: an immediate response would (correctly) release the
    // parked write via the response path, hiding the drain gate under test.
    const heldSends: Array<{ id: number }> = [];
    const { channel, children } = makeChannel({
      responder: (req, child) => {
        if (req.method === "send") { heldSends.push({ id: req.id }); return; }
        child.respond(req.id, req.method === "watch.subscribe" ? { subscription: 1 } : { ok: true });
      },
    });
    await channel.start();
    const child = children[0];
    const sentTexts = () => child.stdin.lines
      .map((l) => JSON.parse(l) as RpcRequest)
      .filter((r) => r.method === "send")
      .map((r) => r.params.text);

    // The first send's write returns false (full pipe); its chain link then
    // waits for 'drain' before the next write is allowed through.
    child.stdin.backpressureWrites = 1;
    const p1 = channel.send({ chatId: DM_GUID, text: "first" });
    await settle();
    expect(sentTexts()).toEqual(["first"]);

    // The second send is queued behind the un-drained first write — its bytes
    // must not hit stdin yet.
    const p2 = channel.send({ chatId: DM_GUID, text: "second" });
    await settle();
    expect(sentTexts()).toEqual(["first"]);
    expect(child.stdin.listenerCount("drain")).toBeGreaterThan(0);

    // Drain releases the backlog; the held write now goes out, in order.
    child.stdin.emit("drain");
    await settle();
    expect(sentTexts()).toEqual(["first", "second"]);

    // Answer the held sends so both calls resolve.
    for (const { id } of heldSends.splice(0)) child.respond(id, { ok: true });
    await Promise.all([p1, p2]);
    await channel.stop();
  });

  it("fails a request cleanly once the pending queue is saturated", async () => {
    // Answer only watch.subscribe, so every send stays pending forever.
    const { channel } = makeChannel({
      responder: (req, child) => {
        if (req.method === "watch.subscribe") child.respond(req.id, { subscription: 1 });
      },
    });
    await channel.start();

    const request = (channel as unknown as { request(method: string, params: Record<string, unknown>): Promise<unknown> }).request.bind(channel);
    for (let i = 0; i < 256; i++) void (request("send", { chat_guid: DM_GUID, text: `x${i}` }) as Promise<unknown>).catch(() => {});

    await expect(request("send", { chat_guid: DM_GUID, text: "overflow" })).rejects.toThrow(/pending queue full/);
    await channel.stop();
  });

  it("skips a queued write whose request already timed out (no late duplicate send) (round-2 #3)", async () => {
    vi.useFakeTimers();
    // Sends stay unanswered: a response to the first send would settle its
    // parked link and release the queued second write before the timeout.
    const { channel, children } = makeChannel({
      responder: (req, child) => {
        if (req.method === "send") return;
        child.respond(req.id, req.method === "watch.subscribe" ? { subscription: 1 } : { ok: true });
      },
    });
    await channel.start();
    const child = children[0];
    const sentTexts = () => child.stdin.lines
      .map((l) => JSON.parse(l) as RpcRequest)
      .filter((r) => r.method === "send")
      .map((r) => r.params.text);

    const request = (channel as unknown as {
      request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    }).request.bind(channel);

    // The first send backpressures (write returns false), so the second send's
    // write stays QUEUED behind the un-drained first.
    child.stdin.backpressureWrites = 1;
    void (request("send", { chat_guid: DM_GUID, text: "first" }, 60_000) as Promise<unknown>).catch(() => {});
    const p2 = (request("send", { chat_guid: DM_GUID, text: "second" }, 1_000) as Promise<unknown>).catch((e: Error) => e);
    await settle();
    expect(sentTexts()).toEqual(["first"]); // second not written — still queued

    // The queued second request times out before drain releases it.
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await p2;
    expect((err as Error).message).toMatch(/timed out/);

    // Drain dequeues the write, but the request is gone → the write is SKIPPED,
    // so no late/duplicate "second" send hits stdin.
    child.stdin.emit("drain");
    await settle();
    expect(sentTexts()).toEqual(["first"]);
    await channel.stop();
  });

  it("settles a parked write when its request times out so the chain proceeds (round-4 #2a)", async () => {
    vi.useFakeTimers();
    // Answer only watch.subscribe/unsubscribe; sends stay pending so responses
    // can't resolve the parked link out from under the test.
    const { channel, children } = makeChannel({
      responder: (req, child) => {
        if (req.method === "send") return;
        child.respond(req.id, req.method === "watch.subscribe" ? { subscription: 1 } : { ok: true });
      },
    });
    await channel.start();
    const child = children[0];
    const sentTexts = () => child.stdin.lines
      .map((l) => JSON.parse(l) as RpcRequest)
      .filter((r) => r.method === "send")
      .map((r) => r.params.text);
    const request = (channel as unknown as {
      request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    }).request.bind(channel);

    // The first send parks on 'drain' (never fires; child stays alive). The
    // second send is queued behind it.
    child.stdin.backpressureWrites = 1;
    const p1 = (request("send", { chat_guid: DM_GUID, text: "first" }, 1_000) as Promise<unknown>).catch((e: Error) => e);
    const p2 = (request("send", { chat_guid: DM_GUID, text: "second" }, 60_000) as Promise<unknown>).catch(() => {});
    await settle();
    expect(sentTexts()).toEqual(["first"]); // second queued behind the parked first

    // First request times out → its parked write link settles → the chain
    // proceeds and the second write goes out (never wedged).
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p1 as Error).message).toMatch(/timed out/);
    await settle();
    expect(sentTexts()).toEqual(["first", "second"]);
    void p2;
    await channel.stop();
  });

  it("releases a parked write when its response arrives, without waiting for 'drain'", async () => {
    // defaultResponder answers every request — the response itself (proof the
    // child consumed the line) must settle the parked link, so the next write
    // goes out even though 'drain' never fires.
    const { channel, children } = makeChannel();
    await channel.start();
    const child = children[0];
    const sentTexts = () => child.stdin.lines
      .map((l) => JSON.parse(l) as RpcRequest)
      .filter((r) => r.method === "send")
      .map((r) => r.params.text);

    child.stdin.backpressureWrites = 1; // first send parks on a full pipe
    const p1 = channel.send({ chatId: DM_GUID, text: "first" });
    const p2 = channel.send({ chatId: DM_GUID, text: "second" });
    await settle(12);
    expect(sentTexts()).toEqual(["first", "second"]);
    await Promise.all([p1, p2]);
    await channel.stop();
  });

  it("restarts a live child that stops draining so the write chain recovers (round-4 #2b)", async () => {
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
    const child0 = children[0];

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

    // Restart backoff → a fresh child subscribes; the write chain works again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    await vi.waitFor(() => {
      const sub = children[1].stdin.lines.map((l) => JSON.parse(l) as RpcRequest).find((r) => r.method === "watch.subscribe");
      expect(sub).toBeDefined();
    });
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

  it("rejects in-flight requests when a RESTART's subscribe fails (no hang) (round-2 #2)", async () => {
    vi.useFakeTimers();
    let failSubscribe = false;
    let releaseSubscribe: (() => void) | null = null;
    const { channel, children } = makeChannel({
      config: { restartDelaysMs: [1_000] },
      responder: (req, child) => {
        if (req.method === "watch.subscribe") {
          if (!failSubscribe) return child.respond(req.id, { subscription: 1 });
          // Hold the (doomed) subscribe so a send can be issued mid-restart.
          releaseSubscribe = () => child.respondError(req.id, -32603, "err", "nope");
          return;
        }
        // sends are never answered
      },
    });
    await channel.start();

    // Crash the healthy child; the restart's subscribe will hang, then fail.
    failSubscribe = true;
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000); // spawn child 1, subscribe held
    expect(children).toHaveLength(2);

    // A request issued to the new child while subscribe is still in flight.
    const sendP = channel.send({ chatId: DM_GUID, text: "during restart" });
    let settled = false;
    void sendP.then(() => { settled = true; }, () => { settled = true; });
    await settle();
    expect(settled).toBe(false); // pending while subscribe is in flight

    // The subscribe now fails → the failed-subscribe path must reject the
    // in-flight send rather than leaving it to hang until timeout.
    releaseSubscribe!();
    await settle();
    expect(settled).toBe(true);
    await expect(sendP).rejects.toThrow(/subscribe failed/);
    expect(children[1].killed).toBe(true);
    await channel.stop();
  });
});

// --- Edit gating (Codex LOW #5) -------------------------------------------------

describe("imsg edit gating requires the full capability set", () => {
  const editParams = ["any;-;+15551234567", "mine-1", "fixed text"] as const;

  it("refuses when the bridge is down even if a selector is set", async () => {
    const caps: ImsgCapabilities = { ...CAPS_FULL, advancedFeatures: false, selectors: { editMessageItem: true } };
    const { channel, requests } = makeChannel({ caps });
    await channel.start();
    await expect(channel.editMessage(...editParams)).rejects.toThrow(/unsupported on this macOS/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");
    await channel.stop();
  });

  it("refuses when imsg does not advertise message.edit", async () => {
    const caps: ImsgCapabilities = {
      ...CAPS_FULL,
      rpcMethods: new Set(["send", "watch.subscribe"]),
      selectors: { editMessageItem: true },
    };
    const { channel, requests } = makeChannel({ caps });
    await channel.start();
    await expect(channel.editMessage(...editParams)).rejects.toThrow(/unsupported on this macOS/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");
    await channel.stop();
  });

  it("allows edit only with bridge + message.edit + a live selector", async () => {
    const caps: ImsgCapabilities = {
      ...CAPS_FULL,
      advancedFeatures: true,
      rpcMethods: new Set([...CAPS_FULL.rpcMethods, "message.edit"]),
      selectors: { editMessageItem: true },
    };
    const { channel, requests } = makeChannel({ caps });
    await channel.start();
    await channel.editMessage(...editParams);
    expect(requests().find((r) => r.method === "message.edit")).toBeDefined();
    await channel.stop();
  });
});

// --- Capability re-probe: startup retry + on-demand (#258) -----------------------
// A boot-order race (daemon up before Messages.app has the bridge injected —
// every macOS-update reboot) used to freeze a degraded startup snapshot for the
// whole process lifetime. The channel now retries the probe silently with
// backoff at startup, warns only once the schedule is exhausted, and re-probes
// (rate-limited, in the background) whenever a capability-gated call finds the
// cached answer false — so a bridge that appears later is picked up without a
// restart, and a race that resolves itself resolves without a warning.

describe("imsg capability re-probe (#258)", () => {
  const bridgeWarns = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => c.some((a) => typeof a === "string" && a.includes("imsg bridge NOT injected")));

  it("retries a degraded startup probe with backoff and upgrades SILENTLY when the bridge comes up", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, "warn");
    let probeCount = 0;
    const probe = vi.fn(async () => {
      probeCount++;
      return probeCount >= 3 ? CAPS_FULL : CAPS_BASIC; // bridge appears on the 2nd retry
    });
    const { channel, requests } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [1_000, 2_000, 4_000] },
    });
    await channel.start();
    expect(probe).toHaveBeenCalledTimes(1);

    // While degraded, typing is the usual no-op (and the startup loop owns
    // probing — the gated call does not spawn its own).
    channel.startTyping(DM_GUID);
    await settle();
    expect(requests().map((r) => r.method)).not.toContain("typing");
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // retry 1 → still degraded
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000); // retry 2 → bridge is up
    expect(probe).toHaveBeenCalledTimes(3);

    // Healed: typing flows without a channel restart.
    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();
    expect(requests().some((r) => r.method === "typing")).toBe(true);

    // The loop ended (no further probes) and the whole race resolved silently.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(bridgeWarns(warnSpy)).toHaveLength(0);
    await channel.stop();
  });

  it("also retries when the startup probe THROWS (imsg status not answering yet)", async () => {
    vi.useFakeTimers();
    let probeCount = 0;
    const probe = vi.fn(async () => {
      probeCount++;
      if (probeCount === 1) throw new Error("status probe failed");
      return CAPS_FULL;
    });
    const { channel, requests } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [1_000] },
    });
    await channel.start(); // NO_CAPABILITIES snapshot, but startup does not fail
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);

    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();
    expect(requests().some((r) => r.method === "typing")).toBe(true);
    await channel.stop();
  });

  it("warns only after the retry schedule is exhausted, then a later on-demand re-probe still heals", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, "warn");
    let bridgeUp = false;
    const probe = vi.fn(async () => (bridgeUp ? CAPS_FULL : CAPS_BASIC));
    const { channel, requests } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [1_000] },
    });
    await channel.start();
    expect(bridgeWarns(warnSpy)).toHaveLength(0); // silent while retries are pending

    await vi.advanceTimersByTimeAsync(1_000); // last retry fails → the warning fires ONCE
    expect(probe).toHaveBeenCalledTimes(2);
    expect(bridgeWarns(warnSpy)).toHaveLength(1);

    // The bridge appears later (Messages.app finally up, or the user ran
    // `imsg launch`). A gated call past the rate-limit floor kicks a
    // background re-probe...
    bridgeUp = true;
    await vi.advanceTimersByTimeAsync(30_000);
    channel.startTyping(DM_GUID);
    await settle();
    expect(probe).toHaveBeenCalledTimes(3);

    // ...and the NEXT gated call sees the upgraded snapshot.
    const stopTyping = channel.startTyping(DM_GUID);
    await settle();
    await stopTyping();
    expect(requests().some((r) => r.method === "typing")).toBe(true);
    expect(bridgeWarns(warnSpy)).toHaveLength(1); // still exactly one warning
    await channel.stop();
  });

  it("rate-limits on-demand re-probes (no subprocess per gated call)", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => CAPS_BASIC);
    // Empty retry schedule → the startup loop is exhausted immediately and
    // on-demand probing owns the degraded state from the start.
    const { channel } = makeChannel({ config: { probeCapabilities: probe, capabilityRetryDelaysMs: [] } });
    await channel.start();
    expect(probe).toHaveBeenCalledTimes(1);

    // Gated calls inside the floor (30s since the startup probe): no probe.
    channel.startTyping(DM_GUID);
    channel.startTyping(DM_GUID);
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);

    // Past the floor: exactly ONE probe despite several gated calls.
    await vi.advanceTimersByTimeAsync(30_000);
    channel.startTyping(DM_GUID);
    channel.startTyping(DM_GUID);
    channel.startTyping(DM_GUID);
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);

    // The next window allows the next probe.
    await vi.advanceTimersByTimeAsync(30_000);
    channel.startTyping(DM_GUID);
    await settle();
    expect(probe).toHaveBeenCalledTimes(3);
    await channel.stop();
  });

  it("picks the bridge up from the inbound read-receipt gate without a restart", async () => {
    let bridgeUp = false;
    const probe = vi.fn(async () => (bridgeUp ? CAPS_FULL : CAPS_BASIC));
    const { channel, children, requests } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [], capabilityReprobeMinIntervalMs: 0 },
    });
    await channel.start();
    channel.onMessage(vi.fn(async () => {}));

    // The bridge comes up after the (degraded) startup snapshot. The next
    // inbound message still skips the read receipt (cached answer), but its
    // gate kicks a background re-probe.
    bridgeUp = true;
    children[0].notifyMessage(inboundMessage({ id: 100, guid: "reprobe-1" }));
    await vi.waitFor(() => expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2));
    await settle();
    expect(requests().some((r) => r.method === "read")).toBe(false);

    // The refreshed snapshot serves the following message: read goes out.
    children[0].notifyMessage(inboundMessage({ id: 101, guid: "reprobe-2" }));
    await vi.waitFor(() => expect(requests().some((r) => r.method === "read")).toBe(true));
    await channel.stop();
  });

  it("never re-probes while the bridge is up (editSupported=false alone is not a trigger)", async () => {
    // On macOS 26 editSupported is false WITH a live bridge — a real OS limit,
    // not staleness. A failed edit must not burn a probe subprocess on it.
    const probe = vi.fn(async () => CAPS_FULL);
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityReprobeMinIntervalMs: 0 },
    });
    await channel.start();
    expect(probe).toHaveBeenCalledTimes(1);

    await expect(channel.editMessage(DM_GUID, "mine-1", "fixed")).rejects.toThrow(/unsupported on this macOS/i);
    await settle();
    expect(probe).toHaveBeenCalledTimes(1); // no re-probe: advanced_features is already true
    await channel.stop();
  });

  it("keeps the cached snapshot when an on-demand re-probe fails", async () => {
    let probeCount = 0;
    const probe = vi.fn(async () => {
      probeCount++;
      if (probeCount > 1) throw new Error("imsg went away");
      return CAPS_BASIC;
    });
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [], capabilityReprobeMinIntervalMs: 0 },
    });
    await channel.start();

    channel.startTyping(DM_GUID); // triggers a re-probe that throws
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);
    // Still degraded, still functional: typing stays a no-op, nothing crashed.
    channel.startTyping(DM_GUID);
    await settle();
    expect(probe).toHaveBeenCalledTimes(3);
    await channel.stop();
  });

  it("does not leak the retry loop when startup fails after a degraded probe", async () => {
    // scheduleCapabilityRetry arms only after spawn+subscribe succeeds: a
    // channel whose start() rejected must not keep spawning `imsg status`
    // probes (and eventually warn) for a channel that isn't running.
    vi.useFakeTimers();
    const probe = vi.fn(async () => CAPS_BASIC);
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [1_000] },
      responder: (req, child) => child.respondError(req.id, -32603, "Internal error", "Full Disk Access required"),
    });
    await expect(channel.start()).rejects.toThrow(/Full Disk Access/);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(1); // the startup probe only — no orphan loop
  });

  it("reports a probe that kept THROWING as a probe failure, not as a missing bridge", async () => {
    // A missing/broken imsg binary, spawn error, or timeout is operationally
    // different from a healthy probe answering advanced_features=false —
    // telling the operator to run `imsg launch` for it points at the wrong
    // subsystem (the same confidently-wrong-message shape #258 is about).
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, "warn");
    const probe = vi.fn(async () => { throw new Error("spawn imsg ENOENT"); });
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [1_000] },
    });
    await channel.start();
    await vi.advanceTimersByTimeAsync(1_000); // retry throws too → schedule exhausted
    expect(probe).toHaveBeenCalledTimes(2);

    const probeFailWarns = warnSpy.mock.calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("imsg status probe still failing")));
    expect(probeFailWarns).toHaveLength(1);
    expect(bridgeWarns(warnSpy)).toHaveLength(0); // never blames the bridge
    await channel.stop();
  });

  it("blames the bridge at exhaustion when the LAST probe answered (even if earlier ones threw)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, "warn");
    let probeCount = 0;
    const probe = vi.fn(async () => {
      probeCount++;
      if (probeCount === 1) throw new Error("not answering yet");
      return CAPS_BASIC; // later probes answer: the bridge really is down
    });
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [1_000] },
    });
    await channel.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(2);

    expect(bridgeWarns(warnSpy)).toHaveLength(1); // accurate: run `imsg launch`
    const probeFailWarns = warnSpy.mock.calls.filter((c) =>
      c.some((a) => typeof a === "string" && a.includes("imsg status probe still failing")));
    expect(probeFailWarns).toHaveLength(0);
    await channel.stop();
  });

  it("does not mutate the capability snapshot from a probe that resolves after stop()", async () => {
    let release!: (caps: ImsgCapabilities) => void;
    const gate = new Promise<ImsgCapabilities>((resolve) => { release = resolve; });
    let probeCount = 0;
    const probe = vi.fn(async () => {
      probeCount++;
      return probeCount === 1 ? CAPS_BASIC : gate; // the on-demand re-probe hangs
    });
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [], capabilityReprobeMinIntervalMs: 0 },
    });
    await channel.start();

    channel.startTyping(DM_GUID); // kicks the gated re-probe, which parks on the gate
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);

    await channel.stop();
    release(CAPS_FULL); // the probe resolves on a stopped channel
    await settle();

    const internals = channel as unknown as { capabilities: ImsgCapabilities };
    expect(internals.capabilities.advancedFeatures).toBe(false); // snapshot untouched
  });

  it("cancels the startup retry loop on stop()", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => CAPS_BASIC);
    const { channel } = makeChannel({
      config: { probeCapabilities: probe, capabilityRetryDelaysMs: [5_000, 5_000] },
    });
    await channel.start();
    expect(probe).toHaveBeenCalledTimes(1);

    await channel.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1); // no probes after stop
  });
});
