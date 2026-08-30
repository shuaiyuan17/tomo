import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import type { DeliveryPipeline as DeliveryPipelineType } from "../src/agent/delivery-pipeline.js";
import type { TelegramChannel as TelegramChannelType } from "../src/channels/telegram.js";

// ---------------------------------------------------------------------------
// A `MEDIA:` path is checked with existsSync in the pipeline and opened again,
// later, by the channel. A file that disappears in that window takes the whole
// send down — grammY's InputFile ENOENTs at request time — and `captionSent`
// used to be set on having CALLED send, so the text went with the picture and
// the sticker run after it never happened.
//
// Two rules are pinned here. A DEFINITE pre-flight failure (the file is gone)
// frees the caption to go out as text and is recorded as exactly that: caption
// delivered, picture not. An AMBIGUOUS failure (a network error that may have
// landed the captioned picture) does NOT re-send the caption — the channels
// already refuse that retry on their own paths, because a duplicate is worse
// than a gap.
//
// HOME/TOMO_WORKSPACE are stubbed to a scratch dir before the modules are
// imported; the Telegram bot's API surface is replaced wholesale, so nothing
// reaches the network.
// ---------------------------------------------------------------------------

let home = "";
let mediaPath = "";
let DeliveryPipeline: typeof DeliveryPipelineType;
let TelegramChannel: typeof TelegramChannelType;
let PartialDeliveryError: typeof import("../src/agent/delivery-pipeline.js").PartialDeliveryError;
let failedDeliveryEntry: typeof import("../src/agent/delivery-pipeline.js").failedDeliveryEntry;
let DELIVERY_FAILED_MARKER: string;

interface Recorded {
  photos: Array<{ caption?: string; replyToId?: number }>;
  messages: Array<{ text: string; replyToId?: number }>;
  stickers: Array<{ id: string; replyToId?: number }>;
}

type PhotoFailure = "none" | "enoent" | "ambiguous" | "refused";
type Fakes = { photo: PhotoFailure; stickerFails?: boolean; messageFailsOnce?: boolean };

/** A Telegram channel whose sendPhoto fails the way a vanished file — or a dropped connection — does. */
function makeTelegram(photoFailure: PhotoFailure | Fakes): { channel: TelegramChannelType; recorded: Recorded } {
  const fakes: Fakes = typeof photoFailure === "string" ? { photo: photoFailure } : photoFailure;
  const channel = new TelegramChannel("000000:test-token");
  const recorded: Recorded = { photos: [], messages: [], stickers: [] };
  let nextId = 100;
  let messageFailures = fakes.messageFailsOnce ? 1 : 0;
  type Opts = { caption?: string; reply_parameters?: { message_id: number } };
  (channel as unknown as { bot: { api: unknown } }).bot.api = {
    sendPhoto: async (_chatId: string | number, _file: unknown, opts?: Opts) => {
      const photoFailure = fakes.photo;
      if (photoFailure === "refused") {
        // The Bot API answered, and the answer was no: nothing was sent.
        throw new GrammyError(
          "Call to 'sendPhoto' failed!",
          { ok: false, error_code: 400, description: "Bad Request: IMAGE_PROCESS_FAILED" },
          "sendPhoto",
          {},
        );
      }
      if (photoFailure === "enoent") {
        // The shape grammY's InputFile surfaces, wrapped the way a network
        // layer wraps it: the fs code sits down the chain, not on top.
        const fsError = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        throw Object.assign(new Error("Network request for 'sendPhoto' failed!"), { error: fsError });
      }
      if (photoFailure === "ambiguous") {
        throw new Error("Network request for 'sendPhoto' failed!");
      }
      recorded.photos.push({ caption: opts?.caption, replyToId: opts?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
    sendMessage: async (_chatId: string | number, text: string, opts?: Opts) => {
      if (messageFailures > 0) {
        messageFailures--;
        throw new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: "Bad Request: text refused" }, "sendMessage", {});
      }
      recorded.messages.push({ text, replyToId: opts?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
    sendSticker: async (_chatId: string | number, sticker: string, opts?: Opts) => {
      if (fakes.stickerFails) throw new Error("Network request for 'sendSticker' failed!");
      recorded.stickers.push({ id: sticker, replyToId: opts?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
  };
  return { channel, recorded };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tomo-caption-fallback-"));
  // A real file, so the pipeline's existsSync passes and the failure happens
  // where it happens in production: inside the channel.
  mediaPath = join(home, "chart.png");
  writeFileSync(mediaPath, "not really a png");
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("TOMO_WORKSPACE", join(home, "workspace"));
  ({ DeliveryPipeline, PartialDeliveryError, failedDeliveryEntry } = await import("../src/agent/delivery-pipeline.js"));
  ({ DELIVERY_FAILED_MARKER } = await import("../src/agent/block-transcript.js"));
  ({ TelegramChannel } = await import("../src/channels/telegram.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function pipeline(): DeliveryPipelineType {
  return new DeliveryPipeline({ queuePendingErrorNote: () => {} });
}

/** Run a deliver that is expected to fail and hand back the error. */
async function failing(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected deliver() to reject");
}

describe("a caption survives an attachment send that fails before dispatch", () => {
  it("delivers the text when Telegram's photo send fails on the file", async () => {
    const { channel, recorded } = makeTelegram("enoent");
    const sender = pipeline().createBlockSender(channel, "12345");
    const block = `Here's the chart\nMEDIA:${mediaPath}`;

    // The failure is still surfaced — the picture really did not ship — but
    // as a PARTIAL one, so the transcript can say which half.
    const err = await failing(sender.deliver(block));
    expect(err).toBeInstanceOf(PartialDeliveryError);

    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
    expect(failedDeliveryEntry(block, err)).toBe(`Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}`);
  });

  it("delivers the text when the file vanishes between the pipeline's check and the channel's", async () => {
    const { channel, recorded } = makeTelegram("none");
    // The channel's own pre-check is the definite failure here: the sendPhoto
    // fake would have succeeded, and must never be reached.
    const original = channel.send.bind(channel);
    vi.spyOn(channel, "send").mockImplementation(async (message) => {
      if (message.photo) rmSync(message.photo, { force: true });
      return original(message);
    });
    const sender = pipeline().createBlockSender(channel, "12345");

    const err = await failing(sender.deliver(`Here's the chart\nMEDIA:${mediaPath}`));
    expect(err).toBeInstanceOf(PartialDeliveryError);
    expect(recorded.photos).toEqual([]);
    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
  });

  it("hands the reply target to the caption the failed photo could not take", async () => {
    const { channel, recorded } = makeTelegram("enoent");
    const sender = pipeline().createBlockSender(channel, "12345", { replyTo: "77" });

    await failing(sender.deliver(`Here's the chart\nMEDIA:${mediaPath}`));

    expect(recorded.messages).toEqual([{ text: "Here's the chart", replyToId: 77 }]);
  });

  it("still ships a sticker that follows the failed photo in the same block", async () => {
    const { channel, recorded } = makeTelegram("enoent");
    const sender = pipeline().createBlockSender(channel, "12345");
    const block = `Here's the chart\nMEDIA:${mediaPath}\nSTICKER:sticker-abc`;

    const err = await failing(sender.deliver(block));

    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
    expect(recorded.stickers.map((s) => s.id)).toEqual(["sticker-abc"]);
    expect(failedDeliveryEntry(block, err)).toBe(
      `Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}\nSTICKER:sticker-abc`,
    );
  });

  it("moves the caption onto the next picture when the first fails before dispatch", async () => {
    const other = join(home, "other.png");
    writeFileSync(other, "also not a png");
    const { channel, recorded } = makeTelegram("none");
    const original = channel.send.bind(channel);
    // Only the FIRST picture is gone.
    vi.spyOn(channel, "send").mockImplementation(async (message) => {
      if (message.photo === mediaPath) rmSync(message.photo, { force: true });
      return original(message);
    });
    const sender = pipeline().createBlockSender(channel, "12345");
    const block = `Here's the chart\nMEDIA:${mediaPath}\nMEDIA:${other}`;

    const err = await failing(sender.deliver(block));

    // Nothing went out with the first picture, so the caption is still free
    // to ride the second — one message fewer than a text fallback.
    expect(recorded.photos.map((p) => p.caption)).toEqual(["Here's the chart"]);
    expect(recorded.messages).toEqual([]);
    expect(failedDeliveryEntry(block, err)).toBe(
      `Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}\nMEDIA:${other}`,
    );
  });

  it("treats a Bot API refusal as definite too — the caption goes out as text", async () => {
    const { channel, recorded } = makeTelegram("refused");
    const sender = pipeline().createBlockSender(channel, "12345", { replyTo: "77" });
    const block = `Here's the chart\nMEDIA:${mediaPath}`;

    const err = await failing(sender.deliver(block));

    expect(recorded.messages).toEqual([{ text: "Here's the chart", replyToId: 77 }]);
    expect(failedDeliveryEntry(block, err)).toBe(`Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}`);
  });

  it("records a failed sticker as failed and nothing else", async () => {
    const { channel, recorded } = makeTelegram({ photo: "enoent", stickerFails: true });
    const sender = pipeline().createBlockSender(channel, "12345");
    const block = `Here's the chart\nMEDIA:${mediaPath}\nSTICKER:sticker-abc`;

    const err = await failing(sender.deliver(block));
    expect(err).toBeInstanceOf(PartialDeliveryError);

    // The caption went out; a sticker failure after it must not un-deliver it.
    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
    expect(failedDeliveryEntry(block, err)).toBe(
      `Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}\n${DELIVERY_FAILED_MARKER}STICKER:sticker-abc`,
    );
  });

  it("keeps the picture delivered when only its over-limit caption failed, and retries the text", async () => {
    // A caption over Telegram's 1024-char limit ships as a second call. The
    // channel reports the picture shipped (PartialSendError) and the refusal
    // is definite, so the caption is free to go out as text on its own.
    const { channel, recorded } = makeTelegram({ photo: "none", messageFailsOnce: true });
    const sender = pipeline().createBlockSender(channel, "12345");
    const longCaption = "x".repeat(1500);
    const block = `${longCaption}\nMEDIA:${mediaPath}`;

    await sender.deliver(block);

    expect(recorded.photos.map((p) => p.caption)).toEqual([undefined]);
    expect(recorded.messages.map((m) => m.text)).toEqual([longCaption]);
  });

  it("writes the failure entry in the block's own order, tags verbatim", async () => {
    const spaced = join(home, "a b.png");
    writeFileSync(spaced, "not really a png");
    const { channel, recorded } = makeTelegram("none");
    const original = channel.send.bind(channel);
    vi.spyOn(channel, "send").mockImplementation(async (message) => {
      if (message.photo) rmSync(message.photo, { force: true });
      return original(message);
    });
    const sender = pipeline().createBlockSender(channel, "12345");
    const block = `STICKER:sticker-abc\nMEDIA:"${spaced}"\nHere's the chart`;

    const err = await failing(sender.deliver(block));

    expect(recorded.stickers.map((s) => s.id)).toEqual(["sticker-abc"]);
    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
    expect(failedDeliveryEntry(block, err)).toBe(
      `STICKER:sticker-abc\n${DELIVERY_FAILED_MARKER}MEDIA:"${spaced}"\nHere's the chart`,
    );
  });

  it("does not double-send the caption when the photo succeeds", async () => {
    const { channel, recorded } = makeTelegram("none");
    const sender = pipeline().createBlockSender(channel, "12345");

    await sender.deliver(`Here's the chart\nMEDIA:${mediaPath}`);

    expect(recorded.photos.map((p) => p.caption)).toEqual(["Here's the chart"]);
    expect(recorded.messages).toEqual([]);
  });
});

describe("an AMBIGUOUS attachment failure never re-sends the caption", () => {
  it("leaves the caption alone, still ships the sticker, and marks caption and picture not known", async () => {
    const { channel, recorded } = makeTelegram("ambiguous");
    const sender = pipeline().createBlockSender(channel, "12345", { replyTo: "77" });
    const block = `Here's the chart\nMEDIA:${mediaPath}\nSTICKER:sticker-abc`;

    const err = await failing(sender.deliver(block));
    expect(err).toBeInstanceOf(PartialDeliveryError);

    // The captioned picture may have landed: no second copy of the text.
    expect(recorded.messages).toEqual([]);
    // Independent sends after it still go — but not threaded: the target may
    // already have been spent by the send that failed ambiguously.
    expect(recorded.stickers).toEqual([{ id: "sticker-abc", replyToId: undefined }]);
    expect(failedDeliveryEntry(block, err)).toBe(
      `${DELIVERY_FAILED_MARKER}Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}\nSTICKER:sticker-abc`,
    );
  });

  it("marks the whole block when the failure is not a partial one", () => {
    const block = "plain text";
    expect(failedDeliveryEntry(block, new Error("channel down"))).toBe(`${DELIVERY_FAILED_MARKER}plain text`);
  });
});
