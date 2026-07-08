import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage, StreamingMessage } from "../src/channels/types.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

class FakeChannel implements Channel {
  readonly name = "telegram";
  sent: OutgoingMessage[] = [];

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  createStreamingMessage(): StreamingMessage {
    throw new Error("not used in these tests");
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

function makeStream() {
  const calls = { discarded: 0, committed: 0, canceled: 0, finished: 0 };
  const stream: StreamingMessage = {
    update: () => {},
    finish: async () => { calls.finished++; },
    cancel: async () => { calls.canceled++; },
    discardBlock: async () => { calls.discarded++; },
    commitBlock: async () => { calls.committed++; },
  };
  return { stream, calls };
}

// Attachment blocks (MEDIA:/STICKER:) bypass the StreamingMessage — the block
// handler discards the stream and delivers via deliverAssistantContent — so
// the trailing-NO_REPLY suppression must be enforced in the handler itself:
// a block whose trailing line(s) are bare NO_REPLY ships NOTHING, media and
// stickers included (owner decision 2026-07-08).
describe("DeliveryPipeline attachment blocks and trailing NO_REPLY", () => {
  let dir: string;
  let photoPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-delivery-pipeline-"));
    photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeHandler() {
    const channel = new FakeChannel();
    const { stream, calls } = makeStream();
    const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });
    const handler = pipeline.makeBlockHandler(channel, "123", stream);
    return { channel, stream, calls, handler };
  }

  it("suppresses an attachment block ending in a trailing NO_REPLY line (media not sent)", async () => {
    const { channel, calls, handler } = makeHandler();

    await handler(`took the screenshot MEDIA: ${photoPath}\nNO_REPLY`);

    expect(calls.discarded).toBe(1);
    expect(channel.sent).toHaveLength(0);
  });

  it("suppresses a sticker block ending in a trailing NO_REPLY line", async () => {
    const { channel, calls, handler } = makeHandler();

    await handler("STICKER: 12345\nNO_REPLY");

    expect(calls.discarded).toBe(1);
    expect(channel.sent).toHaveLength(0);
  });

  it("ships an attachment block without the token normally", async () => {
    const { channel, calls, handler } = makeHandler();

    await handler(`took the screenshot MEDIA: ${photoPath}`);

    expect(calls.discarded).toBe(1);
    expect(channel.sent).toEqual([
      { chatId: "123", photo: photoPath, text: "took the screenshot" },
    ]);
  });

  it("still ships an attachment block that merely mentions NO_REPLY inline", async () => {
    const { channel, handler } = makeHandler();

    await handler(`the token is NO_REPLY, screenshot attached MEDIA: ${photoPath}`);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ chatId: "123", photo: photoPath });
  });
});
