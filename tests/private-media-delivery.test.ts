import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Channel, OutgoingMessage } from "../src/channels/types.js";

// ---------------------------------------------------------------------------
// THE ATTACHMENT IS THE READ.
//
// On a barred turn (a group session, or a summoned group steering the owner's
// dm: session) the PreToolUse guard refuses `Read memory/private/x`. It has
// nothing to say about `MEDIA:"memory/private/x"` in a reply block: no tool
// call happens: the harness itself opens the file and hands it to the channel.
// So the same fence has to stand on the outbound side, and it has to answer
// the question the same way — `landsInPrivate`, symlinks resolved.
//
// The scratch root is created before the modules load because
// `isPrivateAttachmentPath` reads `config.workspaceDir` and the workspace
// module's MEMORY_DIR/PRIVATE_MEMORY_DIR; both are stubbed to it.
// ---------------------------------------------------------------------------

const ROOT = mkdtempSync(join(tmpdir(), "tomo-private-media-"));
const MEMORY = join(ROOT, "memory");
const PRIVATE = join(MEMORY, "private");

mkdirSync(PRIVATE, { recursive: true });
writeFileSync(join(PRIVATE, "diary.png"), "owner-only", "utf-8");
writeFileSync(join(MEMORY, "cat.png"), "public", "utf-8");
// A link the agent is allowed to create: its path spells neither `private` nor
// anything else a text rule could match, and it opens the diary.
symlinkSync(join(PRIVATE, "diary.png"), join(MEMORY, "notes.png"));

/** Absolute, because the pipeline's own `existsSync` resolves a relative path
 *  against the PROCESS cwd while the guard resolves it against the workspace.
 *  Every case that must actually SEND therefore names its file absolutely; the
 *  drop cases don't care, since a dropped path is never opened. */
const PRIVATE_PIC = join(PRIVATE, "diary.png");
const PUBLIC_PIC = join(MEMORY, "cat.png");
const LINK_TO_PRIVATE = join(MEMORY, "notes.png");

vi.mock("../src/config.js", () => ({ config: { workspaceDir: ROOT } }));
vi.mock("../src/workspace/index.js", () => ({
  MEMORY_DIR: MEMORY,
  PRIVATE_MEMORY_DIR: PRIVATE,
  PRIVATE_MEMORY_SUBDIR: "private",
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { log } = await import("../src/logger.js");
const { DeliveryPipeline, PartialDeliveryError, failedDeliveryEntry } =
  await import("../src/agent/delivery-pipeline.js");
const { DELIVERY_FAILED_MARKER } = await import("../src/agent/block-transcript.js");

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Records what actually reached the wire, in order. */
class RecordingChannel implements Channel {
  readonly name = "telegram";
  readonly sent: OutgoingMessage[] = [];

  onMessage(): void {}
  onCommand(): void {}
  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }
  startTyping(): () => void { return () => {}; }
  async start(): Promise<void> {}
  closeIngestion(): void {}
  async quiesce(): Promise<void> {}
  async teardown(): Promise<void> {}
  async stop(): Promise<void> {}
}

function senderFor(barred: boolean): { channel: RecordingChannel; deliver: (block: string) => Promise<void> } {
  const channel = new RecordingChannel();
  const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });
  const sender = pipeline.createBlockSender(channel, "-100270", { blockPrivateMedia: () => barred });
  return { channel, deliver: (block) => sender.deliver(block) };
}

const photos = (channel: RecordingChannel) => channel.sent.filter((m) => m.photo).map((m) => m.photo);
const texts = (channel: RecordingChannel) => channel.sent.filter((m) => !m.photo && m.text).map((m) => m.text);

describe("reply delivery on a barred turn", () => {
  beforeAll(() => {
    vi.mocked(log.warn).mockClear();
  });

  it("drops a private attachment and still delivers the words", async () => {
    const { channel, deliver } = senderFor(true);

    await deliver('Sure, here it is.\nMEDIA:"memory/private/diary.png"');

    expect(photos(channel)).toEqual([]);
    // The caption is treated exactly as it is when the file is missing: it has
    // no picture to ride, so it goes out as text. Losing the picture must not
    // also lose the reply.
    expect(texts(channel)).toEqual(["Sure, here it is."]);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it("drops it when spelled absolutely", async () => {
    const { channel, deliver } = senderFor(true);
    await deliver(`MEDIA:"${PRIVATE_PIC}"`);
    expect(photos(channel)).toEqual([]);
  });

  it("drops it when reached through a symlink out of a public directory", async () => {
    const { channel, deliver } = senderFor(true);
    await deliver(`MEDIA:"${LINK_TO_PRIVATE}"`);
    expect(photos(channel)).toEqual([]);
  });

  it("still sends a public attachment", async () => {
    const { channel, deliver } = senderFor(true);

    await deliver(`the cat MEDIA:"${PUBLIC_PIC}"`);

    expect(photos(channel)).toEqual([PUBLIC_PIC]);
    expect(channel.sent[0].text).toBe("the cat");
  });

  it("drops only the private one when a block carries both", async () => {
    const { channel, deliver } = senderFor(true);

    await deliver(`two MEDIA:"${PRIVATE_PIC}" MEDIA:"${PUBLIC_PIC}"`);

    expect(photos(channel)).toEqual([PUBLIC_PIC]);
  });

  it("does not report the dropped picture as a delivery failure", async () => {
    // Same shape as a file that vanished: never attempted, so the block did
    // not FAIL — it is only not known to have shipped that piece. A throw here
    // would abort the rest of the turn's blocks over a refusal the harness
    // made on purpose.
    const { deliver } = senderFor(true);
    await expect(deliver('MEDIA:"memory/private/diary.png"')).resolves.toBeUndefined();
  });
});

describe("reply delivery on an unbarred turn", () => {
  it("sends the private attachment — the owner's own DM is entitled to it", async () => {
    const { channel, deliver } = senderFor(false);

    await deliver(`here MEDIA:"${PRIVATE_PIC}"`);

    expect(photos(channel)).toEqual([PRIVATE_PIC]);
    expect(channel.sent[0].text).toBe("here");
  });

  it("sends it through the symlink too", async () => {
    const { channel, deliver } = senderFor(false);
    await deliver(`MEDIA:"${LINK_TO_PRIVATE}"`);
    expect(photos(channel)).toEqual([LINK_TO_PRIVATE]);
  });

  it("sends it when no bar getter is supplied at all", async () => {
    const channel = new RecordingChannel();
    const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });
    await pipeline.createBlockSender(channel, "-100270").deliver(`MEDIA:"${PRIVATE_PIC}"`);
    expect(photos(channel)).toEqual([PRIVATE_PIC]);
  });
});

describe("what the transcript records for a dropped attachment", () => {
  it("marks the picture unsent when something else in the block also failed", async () => {
    // The drop alone is not a failure, so pair it with a real one: the
    // per-piece bookkeeping has to say the caption went and the picture did
    // not, rather than marking the whole block either way.
    const channel = new RecordingChannel();
    let failNext = false;
    channel.send = async (message: OutgoingMessage) => {
      if (failNext && message.sticker) throw new Error("sticker refused");
      channel.sent.push(message);
    };
    const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });
    const sender = pipeline.createBlockSender(channel, "-100270", { blockPrivateMedia: () => true });
    failNext = true;

    const block = `words\nMEDIA:"${PRIVATE_PIC}"\nSTICKER:abc`;
    const err = await sender.deliver(block).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PartialDeliveryError);
    const entry = failedDeliveryEntry(block, err);
    expect(entry).toContain(`${DELIVERY_FAILED_MARKER}MEDIA:"${PRIVATE_PIC}"`);
    expect(entry).toContain(`${DELIVERY_FAILED_MARKER}STICKER:abc`);
    // The words did reach the group, and the transcript has to say so.
    expect(entry.startsWith("words\n")).toBe(true);
    expect(entry).not.toContain(`${DELIVERY_FAILED_MARKER}words`);
  });
});
