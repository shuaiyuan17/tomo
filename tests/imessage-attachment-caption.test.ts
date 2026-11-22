import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImsgCapabilities, ImsgChannel as ImsgChannelType } from "../src/channels/imessage-imsg.js";

// ---------------------------------------------------------------------------
// A missing attachment file must not swallow its caption. `sendAttachment`
// used to log "not found" and return normally, which told the pipeline the
// send succeeded — the caption it had handed over with the picture was lost,
// and the block was recorded as delivered. It now throws a DEFINITE pre-flight
// error and sends nothing itself; the pipeline owns the fallback (caption as
// text, picture recorded as failed) for every channel, so it is driven here
// end to end over the fake RPC child too.
//
// $HOME and $TOMO_WORKSPACE are stubbed to a scratch dir BEFORE the channel
// module is imported (it and its transitive imports resolve ~/.tomo paths at
// import time). No real home directory is read or written, and the RPC child
// is a fake — nothing spawns.
// ---------------------------------------------------------------------------

type RpcRequest = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };

class FakeStdin extends EventEmitter {
  writable = true;
  lines: string[] = [];
  onLine: ((req: RpcRequest) => void) | null = null;

  write(line: string, cb?: (err?: Error | null) => void): boolean {
    this.lines.push(line);
    const req = JSON.parse(line) as RpcRequest;
    queueMicrotask(() => this.onLine?.(req));
    cb?.(null);
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
  kill(): boolean { return true; }
  emitPayload(payload: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify(payload)}\n`);
  }
  respond(id: number, result: Record<string, unknown>): void {
    this.emitPayload({ jsonrpc: "2.0", id, result });
  }
}

const CAPS_FULL: ImsgCapabilities = {
  rpcMethods: new Set(["send", "send.rich", "send.attachment", "watch.subscribe"]),
  advancedFeatures: true,
  selectors: { sendAttachment: true },
  typingIndicators: true,
  readReceipts: true,
};

const DM_GUID = "any;-;+15551234567";
const MISSING = "/tmp/tomo-does-not-exist-2f1c9a/chart.png";

let home = "";
let ImsgChannel: typeof ImsgChannelType;
let NULL_SERVICE_LOOKUP: unknown;
let AttachmentUnreadableError: typeof import("../src/channels/types.js").AttachmentUnreadableError;
let DeliveryPipeline: typeof import("../src/agent/delivery-pipeline.js").DeliveryPipeline;
let PartialDeliveryError: typeof import("../src/agent/delivery-pipeline.js").PartialDeliveryError;
let failedDeliveryEntry: typeof import("../src/agent/delivery-pipeline.js").failedDeliveryEntry;
let DELIVERY_FAILED_MARKER: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tomo-imsg-caption-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  ({ ImsgChannel } = await import("../src/channels/imessage-imsg.js"));
  ({ NULL_SERVICE_LOOKUP } = await import("../src/channels/imsg-satellite.js"));
  // Same module graph as the channel (instanceof across a resetModules
  // boundary would compare two different classes).
  ({ AttachmentUnreadableError } = await import("../src/channels/types.js"));
  ({ DeliveryPipeline, PartialDeliveryError, failedDeliveryEntry } = await import("../src/agent/delivery-pipeline.js"));
  ({ DELIVERY_FAILED_MARKER } = await import("../src/agent/block-transcript.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function makeChannel(options: { refuseText?: boolean } = {}) {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    child.stdin.onLine = (req) => {
      if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
      // Refuse every TEXT send with an RPC error response (a definite
      // refusal) while accepting the attachment: the two-call shape.
      if (options.refuseText && typeof req.params.text === "string" && !req.params.file) {
        return child.emitPayload({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "refused" } });
      }
      child.respond(req.id, { ok: true });
    };
    children.push(child);
    return child;
  });
  const channel = new ImsgChannel({
    cliPath: "imsg",
    spawnFn: spawnFn as never,
    probeCapabilities: async () => CAPS_FULL,
    serviceLookup: NULL_SERVICE_LOOKUP as never,
  });
  return {
    channel,
    requests: () => children.flatMap((c) => c.stdin.lines.map((l) => JSON.parse(l) as RpcRequest)),
  };
}

describe("sendAttachment with a missing file", () => {
  it("throws a definite pre-flight error and sends nothing itself", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await expect(
      channel.send({ chatId: DM_GUID, text: "Here's the chart", photo: MISSING, replyTo: "reply-target-guid" }),
    ).rejects.toBeInstanceOf(AttachmentUnreadableError);

    // Not the caption, not the picture: the pipeline decides what happens to
    // the text, and a channel-side send would be invisible to it.
    expect(requests().some((r) => r.method === "send" || r.method === "send.rich" || r.method === "send.attachment")).toBe(false);
    await channel.stop();
  });

  it("is a definite failure with no caption too", async () => {
    const { channel } = makeChannel();
    await channel.start();

    await expect(channel.send({ chatId: DM_GUID, text: "", photo: MISSING })).rejects.toBeInstanceOf(AttachmentUnreadableError);
    await channel.stop();
  });
});

describe("the delivery pipeline over iMessage", () => {
  function vanishingSend(channel: ImsgChannelType): void {
    // The window the fix is about: the file exists at the pipeline's check and
    // is gone by the time the channel looks.
    const original = channel.send.bind(channel);
    vi.spyOn(channel, "send").mockImplementation(async (message) => {
      if (message.photo) rmSync(message.photo, { force: true });
      return original(message);
    });
  }

  it("delivers the caption as text, threads it, and records only the picture as failed", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();
    const mediaPath = join(home, "chart.png");
    writeFileSync(mediaPath, "not really a png");
    vanishingSend(channel);
    const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });
    const sender = pipeline.createBlockSender(channel, DM_GUID, { replyTo: "reply-target-guid" });
    const block = `Here's the chart\nMEDIA:${mediaPath}`;

    let err: unknown;
    try {
      await sender.deliver(block);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PartialDeliveryError);

    // The caption is the turn's last chance at the reply target.
    const rich = requests().find((r) => r.method === "send.rich");
    expect(rich?.params).toMatchObject({ text: "Here's the chart", reply_to: "reply-target-guid" });
    expect(requests().filter((r) => r.method === "send.rich" || r.method === "send")).toHaveLength(1);
    expect(requests().some((r) => r.method === "send.attachment")).toBe(false);
    expect(failedDeliveryEntry(block, err)).toBe(`Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}`);
    await channel.stop();
  });

  it("records the picture as delivered when only its separate caption send was refused", async () => {
    // imsg ships a captioned picture as two RPCs. If the attachment resolves
    // and the caption is refused, the channel reports the picture shipped
    // (PartialSendError) and the pipeline must not un-deliver it. The refusal
    // is definite, so the caption is retried as text — refused again here —
    // and it alone is recorded as failed.
    const { channel, requests } = makeChannel({ refuseText: true });
    await channel.start();
    const mediaPath = join(home, "chart.png");
    writeFileSync(mediaPath, "not really a png");
    const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });
    const sender = pipeline.createBlockSender(channel, DM_GUID);
    const block = `Here's the chart\nMEDIA:${mediaPath}`;

    let err: unknown;
    try {
      await sender.deliver(block);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PartialDeliveryError);

    expect(requests().filter((r) => r.method === "send" && r.params.file === mediaPath)).toHaveLength(1);
    expect(failedDeliveryEntry(block, err)).toBe(`${DELIVERY_FAILED_MARKER}Here's the chart\nMEDIA:${mediaPath}`);
    await channel.stop();
  });
});
