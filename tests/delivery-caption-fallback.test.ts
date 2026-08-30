import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPipeline as DeliveryPipelineType } from "../src/agent/delivery-pipeline.js";
import type { TelegramChannel as TelegramChannelType } from "../src/channels/telegram.js";

// ---------------------------------------------------------------------------
// A `MEDIA:` path is checked with existsSync in the pipeline and opened again,
// later, by the channel. A file that disappears in that window takes the whole
// send down — grammY's InputFile ENOENTs at request time — and `captionSent`
// used to be set on having CALLED send, so the text went with the picture and
// the sticker run after it never happened.
//
// HOME/TOMO_WORKSPACE are stubbed to a scratch dir before the modules are
// imported; the Telegram bot's API surface is replaced wholesale, so nothing
// reaches the network.
// ---------------------------------------------------------------------------

let home = "";
let mediaPath = "";
let DeliveryPipeline: typeof DeliveryPipelineType;
let TelegramChannel: typeof TelegramChannelType;

interface Recorded {
  photos: Array<{ caption?: string; replyToId?: number }>;
  messages: Array<{ text: string; replyToId?: number }>;
  stickers: string[];
}

/** A Telegram channel whose sendPhoto fails the way a vanished file does. */
function makeTelegram(photoFails: boolean): { channel: TelegramChannelType; recorded: Recorded } {
  const channel = new TelegramChannel("000000:test-token");
  const recorded: Recorded = { photos: [], messages: [], stickers: [] };
  let nextId = 100;
  type Opts = { caption?: string; reply_parameters?: { message_id: number } };
  (channel as unknown as { bot: { api: unknown } }).bot.api = {
    sendPhoto: async (_chatId: string | number, _file: unknown, opts?: Opts) => {
      if (photoFails) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
      recorded.photos.push({ caption: opts?.caption, replyToId: opts?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
    sendMessage: async (_chatId: string | number, text: string, opts?: Opts) => {
      recorded.messages.push({ text, replyToId: opts?.reply_parameters?.message_id });
      return { message_id: nextId++ };
    },
    sendSticker: async (_chatId: string | number, sticker: string) => {
      recorded.stickers.push(sticker);
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
  ({ DeliveryPipeline } = await import("../src/agent/delivery-pipeline.js"));
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

describe("a caption survives an attachment send that fails", () => {
  it("delivers the text when Telegram's photo send throws", async () => {
    const { channel, recorded } = makeTelegram(true);
    const sender = pipeline().createBlockSender(channel, "12345");

    // The failure is still surfaced — the caller marks the block with the
    // delivery-failed marker, because the picture really did not ship.
    await expect(sender.deliver(`Here's the chart\nMEDIA:${mediaPath}`)).rejects.toThrow(/ENOENT/);

    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
  });

  it("hands the reply target to the caption the failed photo could not take", async () => {
    const { channel, recorded } = makeTelegram(true);
    const sender = pipeline().createBlockSender(channel, "12345", { replyTo: "77" });

    await expect(sender.deliver(`Here's the chart\nMEDIA:${mediaPath}`)).rejects.toThrow(/ENOENT/);

    expect(recorded.messages).toEqual([{ text: "Here's the chart", replyToId: 77 }]);
  });

  it("still ships a sticker that follows the failed photo in the same block", async () => {
    const { channel, recorded } = makeTelegram(true);
    const sender = pipeline().createBlockSender(channel, "12345");

    await expect(
      sender.deliver(`Here's the chart\nMEDIA:${mediaPath}\nSTICKER:sticker-abc`),
    ).rejects.toThrow(/ENOENT/);

    expect(recorded.messages.map((m) => m.text)).toEqual(["Here's the chart"]);
    expect(recorded.stickers).toEqual(["sticker-abc"]);
  });

  it("does not double-send the caption when the photo succeeds", async () => {
    const { channel, recorded } = makeTelegram(false);
    const sender = pipeline().createBlockSender(channel, "12345");

    await sender.deliver(`Here's the chart\nMEDIA:${mediaPath}`);

    expect(recorded.photos.map((p) => p.caption)).toEqual(["Here's the chart"]);
    expect(recorded.messages).toEqual([]);
  });
});
