/**
 * Counterexamples for the non-streaming, block-typed outbound delivery design.
 *
 * The rejected predecessor (#291) tried to keep thinking text and tool-call
 * debris out of chats by pattern-matching the outbound STRING. That filtered
 * legitimate replies (a one-word `count`, ordinary Chinese prose after a CJK
 * full stop). The replacement never inspects text to decide what ships:
 * `text` content blocks ship, `thinking` content blocks are dropped unless
 * `showThinking` is on. These tests pin that contract.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, OutgoingMessage } from "../src/channels/types.js";
import { splitText } from "../src/channels/text-utils.js";
import { DeliveryPipeline } from "../src/agent/delivery-pipeline.js";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Hard per-message cap used by the iMessage channels (TEXT_CHUNK_LIMIT). */
const IMESSAGE_TEXT_LIMIT = 4000;

/**
 * Stands in for a real channel. `send()` applies the same `splitText` cap the
 * iMessage/Telegram channels apply, so cap-splitting is exercised through the
 * production path rather than asserted on a helper in isolation.
 */
class FakeChannel implements Channel {
  readonly name = "imessage";
  sent: OutgoingMessage[] = [];

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> {
    if (!message.text || message.photo || message.sticker) {
      this.sent.push(message);
      return;
    }
    for (const chunk of splitText(message.text, IMESSAGE_TEXT_LIMIT)) {
      this.sent.push({ ...message, text: chunk });
    }
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

function makePipeline() {
  const channel = new FakeChannel();
  const notes: Array<{ sessionKey: string; visibleError: string }> = [];
  const pipeline = new DeliveryPipeline({
    queuePendingErrorNote: (sessionKey, visibleError) => { notes.push({ sessionKey, visibleError }); },
  });
  const deliver = (response: string) =>
    pipeline.deliverResponse("dm:owner", channel, "chat1", response);
  /** Deliver a turn as the delivery layer really receives it: as blocks. */
  const deliverBlocks = (blocks: string[], options: { replyTo?: string } = {}) =>
    pipeline.deliverResponse("dm:owner", channel, "chat1", blocks.join("\n"), undefined, { ...options, blocks });
  return { channel, pipeline, notes, deliver, deliverBlocks };
}

describe("outbound delivery never inspects the model's own words", () => {
  it("delivers a one-word `count` reply verbatim (#291 P1: was filtered to empty)", async () => {
    const { channel, deliver } = makePipeline();

    await deliver("count");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].text).toBe("count");
  });

  it("delivers a text block that starts with `思考:` verbatim (#291 P1: seam cut real prose)", async () => {
    const { channel, deliver } = makePipeline();
    const reply = "思考: 我建议分两步。 第一步先备份。 第二步再迁移。";

    await deliver(reply);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].text).toBe(reply);
  });
});

describe("one reply, one message", () => {
  it("ships a three-line reply as one send with two embedded newlines", async () => {
    const { channel, deliver } = makePipeline();

    await deliver("line one\nline two\nline three");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].text).toBe("line one\nline two\nline three");
    expect(channel.sent[0].text.split("\n")).toHaveLength(3);
  });

  it("splits a reply past the channel cap into multiple sends without truncating", async () => {
    const { channel, deliver } = makePipeline();
    // Spaces give splitText a break point; no single chunk may exceed the cap.
    const long = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(" ");
    expect(long.length).toBeGreaterThan(IMESSAGE_TEXT_LIMIT);

    await deliver(long);

    expect(channel.sent.length).toBeGreaterThan(1);
    for (const msg of channel.sent) {
      expect(msg.text.length).toBeLessThanOrEqual(IMESSAGE_TEXT_LIMIT);
    }
    // Nothing dropped: splitText breaks on whitespace, so rejoining with a
    // single space reconstructs the original.
    expect(channel.sent.map((m) => m.text).join(" ")).toBe(long);
  });

  it("rewrites [[NL]] to a real newline and never ships the literal token", async () => {
    const { channel, deliver } = makePipeline();

    await deliver("intro[[NL]]detail");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].text).toBe("intro\ndetail");
    expect(channel.sent[0].text).not.toContain("[[NL]]");
  });
});

describe("NO_REPLY suppression survives", () => {
  let dir: string;
  let photoPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-outbound-delivery-"));
    photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ships nothing when a trailing bare NO_REPLY follows a MEDIA: line", async () => {
    const { channel, deliver } = makePipeline();

    await deliver(`took the screenshot MEDIA: ${photoPath}\nNO_REPLY`);

    expect(channel.sent).toHaveLength(0);
  });

  it("ships nothing when a trailing bare NO_REPLY follows a STICKER: line", async () => {
    const { channel, deliver } = makePipeline();

    await deliver("STICKER: 12345\nNO_REPLY");

    expect(channel.sent).toHaveLength(0);
  });

  it("ships a MEDIA: attachment with its caption when the token is absent", async () => {
    const { channel, deliver } = makePipeline();

    await deliver(`took the screenshot MEDIA: ${photoPath}`);

    expect(channel.sent).toEqual([
      { chatId: "chat1", photo: photoPath, text: "took the screenshot" },
    ]);
  });

  it("still ships an attachment whose text merely mentions NO_REPLY inline", async () => {
    const { channel, deliver } = makePipeline();

    await deliver(`the token is NO_REPLY, screenshot attached MEDIA: ${photoPath}`);

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ chatId: "chat1", photo: photoPath });
  });

  it("still delivers a reply that merely mentions NO_REPLY mid-line (#222)", async () => {
    const { channel, deliver } = makePipeline();

    await deliver("I answer with NO_REPLY when I have nothing to add.");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].text).toBe("I answer with NO_REPLY when I have nothing to add.");
  });
});

// ---------------------------------------------------------------------------
// Attachment placement is per BLOCK.
//
// Extracting MEDIA:/STICKER: from the joined turn hoists every attachment to
// the front and collapses the text around it into one caption. The model put
// the tag between two blocks on purpose; delivery has to keep it there.
// ---------------------------------------------------------------------------

describe("block-ordered attachment delivery", () => {
  let dir: string;
  let photoPath: string;
  let otherPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tomo-block-order-"));
    photoPath = join(dir, "pic.png");
    otherPath = join(dir, "other.png");
    writeFileSync(photoPath, "fake");
    writeFileSync(otherPath, "fake");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ships A, photo, B in that order", async () => {
    const { channel, deliverBlocks } = makePipeline();

    await deliverBlocks(["A", `MEDIA:${photoPath}`, "B"]);

    expect(channel.sent).toEqual([
      { chatId: "chat1", text: "A" },
      { chatId: "chat1", photo: photoPath, text: "" },
      { chatId: "chat1", text: "B" },
    ]);
  });

  it("merges adjacent text-only blocks into a single send", async () => {
    const { channel, deliverBlocks } = makePipeline();

    await deliverBlocks(["A", "B", "C"]);

    expect(channel.sent).toEqual([{ chatId: "chat1", text: "A\nB\nC" }]);
  });

  it("keeps each caption with the media of its own block", async () => {
    const { channel, deliverBlocks } = makePipeline();

    await deliverBlocks([`first MEDIA:${photoPath}`, `second MEDIA:${otherPath}`]);

    expect(channel.sent).toEqual([
      { chatId: "chat1", photo: photoPath, text: "first" },
      { chatId: "chat1", photo: otherPath, text: "second" },
    ]);
  });

  it("threads the first shipped message even when it is a photo", async () => {
    const { channel, deliverBlocks } = makePipeline();

    await deliverBlocks([`MEDIA:${photoPath}`, "and here is the summary"], { replyTo: "msg-42" });

    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]).toEqual({ chatId: "chat1", photo: photoPath, text: "", replyTo: "msg-42" });
    // One reply per turn, not one per send.
    expect(channel.sent[1].replyTo).toBeUndefined();
  });

  it("leaves no blank line where a whole-line tag was removed", async () => {
    const { channel, deliverBlocks } = makePipeline();

    await deliverBlocks([`above\nMEDIA:${photoPath}\nbelow`]);

    expect(channel.sent).toEqual([
      { chatId: "chat1", photo: photoPath, text: "above\nbelow" },
    ]);
  });

  it("drops a mid-turn NO_REPLY block whole, attachments included", async () => {
    const { channel, deliverBlocks } = makePipeline();

    await deliverBlocks(["A", `MEDIA:${photoPath}\nNO_REPLY`, "B"]);

    expect(channel.sent).toEqual([{ chatId: "chat1", text: "A\nB" }]);
  });
});
