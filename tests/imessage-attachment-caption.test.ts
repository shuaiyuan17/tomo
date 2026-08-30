import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImsgCapabilities, ImsgChannel as ImsgChannelType } from "../src/channels/imessage-imsg.js";

// ---------------------------------------------------------------------------
// A missing attachment file must not swallow its caption: the caption is
// independently deliverable, and the pipeline hands over `text + photo` as a
// single send, so dropping the whole call loses the text too and still reads
// as delivered.
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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tomo-imsg-caption-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  ({ ImsgChannel } = await import("../src/channels/imessage-imsg.js"));
  ({ NULL_SERVICE_LOOKUP } = await import("../src/channels/imsg-satellite.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function makeChannel() {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const child = new FakeChild();
    child.stdin.onLine = (req) => {
      if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
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
  it("still delivers the caption as text", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.send({ chatId: DM_GUID, text: "Here's the chart", photo: MISSING });

    const sends = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(sends.map((r) => r.params.text)).toContain("Here's the chart");
    await channel.stop();
  });

  it("offers the reply target to the caption and reports its result", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const result = await channel.send({
      chatId: DM_GUID,
      text: "Here's the chart",
      photo: MISSING,
      replyTo: "reply-target-guid",
    });

    const rich = requests().find((r) => r.method === "send.rich");
    expect(rich?.params).toMatchObject({ text: "Here's the chart", reply_to: "reply-target-guid" });
    // The caption carried the target, so the turn threaded after all — and
    // this channel reports a threaded send by returning nothing (only a DROPPED
    // target is reported, as `{ threaded: false }`).
    expect(result).toBeUndefined();
    await channel.stop();
  });

  it("ships nothing and reports the drop when there is no caption", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    const result = await channel.send({ chatId: DM_GUID, photo: MISSING, replyTo: "reply-target-guid" });

    expect(requests().some((r) => r.method === "send" || r.method === "send.rich")).toBe(false);
    expect(result).toEqual({ threaded: false });
    await channel.stop();
  });
});
