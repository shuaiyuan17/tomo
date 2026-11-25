import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { AttachmentUnreadableError } from "../src/channels/types.js";
import { log } from "../src/logger.js";
import { DeliveryPipeline, PartialDeliveryError, failedDeliveryEntry } from "../src/agent/delivery-pipeline.js";
import { DELIVERY_FAILED_MARKER } from "../src/agent/block-transcript.js";
import {
  type RpcRequest,
  CAPS_FULL,
  CAPS_BASIC,
  CAPS_RICHLINK,
  CAPS_STICKER,
  CAPS_ATTACHMENT,
  CAPS_ALL,
  defaultResponder,
  makeChannel,
  DM_GUID,
  inboundMessage,
  settle,
} from "./helpers/fake-imsg.js";

// ImsgChannel tests, split by concern (fakes in tests/helpers/fake-imsg.ts).
// Outbound sends: text, stickers, threaded photos/stickers/text and what they
// report when a reply target cannot be applied, captioned photos, the delivery
// pipeline seam, bare-handle targets, and the RPC param-name contract.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it.each([
    ["the reply target", { replyTo: "guid-target" }, { reply_to: "guid-target" }],
    ["the expressive-send effect", { effect: "confetti" }, { effect: "confetti" }],
  ] as const)("sends %s via send.rich on the first chunk only", async (_, field, param) => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const longText = `${"x".repeat(3990)} ${"y".repeat(100)}`;
    await channel.send({ chatId: DM_GUID, text: longText, ...field });

    const all = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(all[0].method).toBe("send.rich");
    expect(all[0].params).toMatchObject({ chat_guid: DM_GUID, part_index: 0, ...param });
    for (const rest of all.slice(1)) {
      expect(rest.method).toBe("send");
      for (const key of Object.keys(param)) expect(rest.params).not.toHaveProperty(key);
    }
    expect(all.map((r) => r.params.text).join(" ")).toBe(longText);
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
      // Verified against imsg v0.13.4 RPCServer+StickerHandlers.swift:
      // supported params are chat_id|chat_identifier|chat_guid, file,
      // attach_to, part_index.
      expect(all[0].params).toEqual({ chat_guid: DM_GUID, file: stickerPath });
      await channel.stop();
    });
  });

  it("expands a leading ~ before the existence check and the RPC", async () => {
    // Point HOME at a throwaway directory rather than writing a probe file
    // into the developer's real home. `ImsgChannel.send` reads `homedir()` at
    // call time, so the stub is what the expansion under test resolves — and
    // a run killed mid-test can no longer leave a stray file in `~`.
    const home = mkdtempSync(join(tmpdir(), "tomo-imsg-home-"));
    vi.stubEnv("HOME", home);
    const name = "sticker.jpg";
    const absolute = join(home, name);
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
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Both pre-flight refusals REPORT, they do not report success. These two
  // used to assert the silent-drop behaviour: nothing was sent and `send`
  // resolved, so the delivery pipeline recorded a turn that landed while the
  // recipient got nothing — and unlike a caption-bearing photo, a sticker is
  // the whole message, so there was nothing left to salvage. Same typed,
  // definite error `sendAttachment` raises for the identical situation.
  it("reports a Telegram file_id-shaped sticker value instead of dropping it (channel-bound id)", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
    await channel.start();

    await expect(channel.send({ chatId: DM_GUID, text: "", sticker: "CAACAgIAAxkBAAIBOWX1abc123" }))
      .rejects.toThrow(AttachmentUnreadableError);
    // ...and says what is actually wrong. The default "Attachment file not
    // found: CAACAgIAAxk…" reads as a missing PATH and sends whoever is
    // holding the log hunting for a file that was never named; a channel-bound
    // Telegram id is not a path at all.
    await expect(channel.send({ chatId: DM_GUID, text: "", sticker: "CAACAgIAAxkBAAIBOWX1abc123" }))
      .rejects.toThrow("Sticker reference is not a file path: CAACAgIAAxkBAAIBOWX1abc123");

    expect(requests().filter((r) => r.method === "send" || r.method === "send.sticker")).toHaveLength(0);
    await channel.stop();
  });

  it("reports a sticker path that does not exist instead of dropping it", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
    await channel.start();

    await expect(channel.send({ chatId: DM_GUID, text: "", sticker: "/nonexistent/sticker.png" }))
      .rejects.toThrow(AttachmentUnreadableError);

    // Definite by construction, which is what lets the pipeline react without
    // risking a double-send.
    await expect(channel.send({ chatId: DM_GUID, text: "", sticker: "/nonexistent/sticker.png" }))
      .rejects.toMatchObject({ code: "ENOENT", path: "/nonexistent/sticker.png" });
    // A path that isn't there keeps the default wording — that one IS a
    // missing file.
    await expect(channel.send({ chatId: DM_GUID, text: "", sticker: "/nonexistent/sticker.png" }))
      .rejects.toThrow("Attachment file not found: /nonexistent/sticker.png");

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

  it("diagnoses a staging-hygiene refusal (dylib secure-open) and still falls back", async () => {
    await withStickerFile(async (stickerPath) => {
      const warnSpy = vi.spyOn(log, "warn");
      const { channel, requests } = makeChannel({
        caps: CAPS_STICKER,
        responder: (req, child) => {
          if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
          // The exact refusal observed live 2026-08-06: imsg staged the file
          // fine, but the dylib's openUserOwnedDirectorySecurely walk refused
          // (~/Library/Messages was world-writable).
          if (req.method === "send.sticker") return child.respondError(req.id, -32603, "Internal error", "Dylib error: Could not securely open sticker directory");
          child.respond(req.id, { ok: true });
        },
      });
      await channel.start();

      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      // Fallback still happens: the refusal is definite, the sticker must not vanish.
      const plain = requests().filter((r) => r.method === "send");
      expect(plain).toHaveLength(1);

      // And the log carries the staging diagnosis, not just the opaque bridge error.
      const call = warnSpy.mock.calls.find((c) => c.some((a) => typeof a === "string" && a.includes("staging-hygiene")));
      expect(call, "expected a staging-hygiene diagnosis log").toBeDefined();
      const fields = call![0] as { stagingRoot: string; checked: Record<string, string>; verdict: string };
      expect(fields.stagingRoot).toMatch(/Library\/Messages\/Attachments\/imsg\/stickers$/);
      expect(typeof fields.verdict).toBe("string");
      expect(Object.keys(fields.checked).length).toBeGreaterThan(0);
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

/**
 * Threaded attachments and stickers (P2 on #292's second review).
 *
 * The delivery pipeline hands the turn's reply target to exactly ONE message
 * and considers it spent once that send returns. A channel that accepts a
 * `replyTo` on a photo or a sticker and then quietly drops it therefore does
 * not just lose the thread on that bubble — it strands the whole turn
 * unthreaded, because the text after it never gets offered the target. So the
 * contract here is: thread it, or say you did not.
 */
describe("imsg threaded photo and sticker sends", () => {
  const withPhoto = async (fn: (photoPath: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-photo-reply-"));
    const photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake-png-bytes");
    try {
      await fn(photoPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("threads a photo through send.attachment when the bridge has the surface", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "", replyTo: "guid-target" });

      const all = requests().filter((r) => r.method === "send" || r.method === "send.attachment");
      expect(all).toHaveLength(1);
      expect(all[0].method).toBe("send.attachment");
      // Verified against the installed imsg 0.14.1 RPC: `send.attachment`
      // rejects unknown params by name ("unknown send.attachment param: ..."),
      // and accepts reply_to — the only outbound RPC that threads a file.
      expect(all[0].params).toEqual({ chat_guid: DM_GUID, file: photoPath, reply_to: "guid-target" });
      // Target honoured, so the caller must NOT reoffer it to the next block.
      expect(result?.threaded).not.toBe(false);
      await channel.stop();
    });
  });

  it("leaves an unthreaded photo on the plain send path (no replyTo, no bridge round-trip)", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
      await channel.start();

      await channel.send({ chatId: DM_GUID, photo: photoPath, text: "" });

      const all = requests().filter((r) => r.method === "send" || r.method === "send.attachment");
      expect(all).toHaveLength(1);
      expect(all[0].method).toBe("send");
      expect(all[0].params).toEqual({ chat_guid: DM_GUID, file: photoPath });
      await channel.stop();
    });
  });

  it("ships the photo unthreaded and REPORTS the drop when the bridge lacks send.attachment", async () => {
    await withPhoto(async (photoPath) => {
      // CAPS_FULL: bridge up, but no send.attachment RPC / sendAttachment
      // selector — an imsg older than the attachment surface.
      const { channel, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "", replyTo: "guid-target" });

      const all = requests().filter((r) => r.method === "send" || r.method === "send.attachment");
      expect(all).toHaveLength(1);
      expect(all[0].method).toBe("send");
      expect(all[0].params).toEqual({ chat_guid: DM_GUID, file: photoPath });
      expect(result).toEqual({ threaded: false });
      await channel.stop();
    });
  });

  it("falls back to an unthreaded send and reports the drop when send.attachment is refused", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({
        caps: CAPS_ATTACHMENT,
        responder: (req, child) => {
          if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
          if (req.method === "send.attachment") return child.respondError(req.id, -32602, "Invalid params", "no reply target");
          child.respond(req.id, { ok: true });
        },
      });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "", replyTo: "guid-target" });

      const methods = requests().filter((r) => r.method === "send" || r.method === "send.attachment").map((r) => r.method);
      expect(methods).toEqual(["send.attachment", "send"]);
      expect(result).toEqual({ threaded: false });
      await channel.stop();
    });
  });

  it.each([
    ["", "no caption"],
    ["Here's the chart", "a caption"],
  ])("throws a definite pre-flight error when the attachment file is missing, so nothing shipped spends the target (text %j: %s)", async (text) => {
    const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
    await channel.start();

    // Thrown, not swallowed: a `{ threaded: false }` return read as "shipped,
    // unthreaded" to the delivery pipeline, which then recorded the block as
    // delivered — and a caption handed over with the picture was lost. The
    // pipeline owns the caption fallback on this error, so the channel sends
    // neither the caption nor the picture: a channel-side send would be
    // invisible to it.
    await expect(
      channel.send({ chatId: DM_GUID, photo: "/nonexistent/pic.png", text, replyTo: "guid-target" }),
    ).rejects.toBeInstanceOf(AttachmentUnreadableError);

    expect(requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method))).toHaveLength(0);
    await channel.stop();
  });

  it("never threads the caption follow-up behind a threaded photo", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
      await channel.start();

      await channel.send({ chatId: DM_GUID, photo: photoPath, text: "here it is", replyTo: "guid-target" });

      const rich = requests().filter((r) => r.method === "send.rich");
      expect(rich).toHaveLength(0);
      const plain = requests().filter((r) => r.method === "send");
      expect(plain).toHaveLength(1);
      expect(plain[0].params).toEqual({ chat_guid: DM_GUID, text: "here it is" });
      await channel.stop();
    });
  });

  it("reports that a sticker cannot be threaded instead of swallowing the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-sticker-reply-"));
    const stickerPath = join(dir, "dog.png");
    writeFileSync(stickerPath, "fake-png-bytes");
    try {
      const { channel, requests } = makeChannel({ caps: CAPS_STICKER });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath, replyTo: "guid-target" });

      const stickers = requests().filter((r) => r.method === "send.sticker");
      expect(stickers).toHaveLength(1);
      // send.sticker takes no reply_to at all — imsg rejects the param.
      expect(stickers[0].params).toEqual({ chat_guid: DM_GUID, file: stickerPath });
      expect(result).toEqual({ threaded: false });
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about threading when a sticker send was never asked to thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-sticker-noreply-"));
    const stickerPath = join(dir, "dog.png");
    writeFileSync(stickerPath, "fake-png-bytes");
    try {
      const { channel } = makeChannel({ caps: CAPS_STICKER });
      await channel.start();

      expect(await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath })).toBeUndefined();
      await channel.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P2-1 (#292's third review): the plain-text fallback used to return `void`.
 *
 * `Channel.send` returning nothing means "delivered as asked", and the
 * pipeline retires the turn's reply target on it. But the AppleScript `send`
 * has no `reply_to` param at all — every fallback onto it drops the target on
 * the floor. Claiming success there is worse than not threading: the target
 * is spent, so no later block in the turn is ever offered it either.
 */
describe("imsg threaded text sends report a reply target they could not apply", () => {
  it("reports the drop when the bridge is down and the text goes out plain", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    const result = await channel.send({ chatId: DM_GUID, text: "threaded?", replyTo: "guid-target" });

    const outbound = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(outbound.map((r) => r.method)).toEqual(["send"]);
    expect(outbound[0].params).toEqual({ chat_guid: DM_GUID, text: "threaded?" });
    expect(result).toEqual({ threaded: false });
    await channel.stop();
  });

  it("reports the drop when send.rich refuses and the text falls back to plain", async () => {
    const { channel, requests } = makeChannel({
      caps: CAPS_FULL,
      responder: (req, child) => {
        if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
        if (req.method === "send.rich") return child.respondError(req.id, -32603, "Internal error", "bridge not running");
        child.respond(req.id, { ok: true });
      },
    });
    await channel.start();

    const result = await channel.send({ chatId: DM_GUID, text: "threaded?", replyTo: "guid-target" });

    const outbound = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(outbound.map((r) => r.method)).toEqual(["send.rich", "send"]);
    expect(result).toEqual({ threaded: false });
    await channel.stop();
  });

  it("stays silent when send.rich accepted the reply target", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const result = await channel.send({ chatId: DM_GUID, text: "threaded!", replyTo: "guid-target" });

    const outbound = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(outbound.map((r) => r.method)).toEqual(["send.rich"]);
    expect(outbound[0].params).toMatchObject({ reply_to: "guid-target" });
    expect(result?.threaded).not.toBe(false);
    await channel.stop();
  });

  it("reports the drop on a chunked long message whose first chunk went out plain", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    const longText = `${"x".repeat(3990)} ${"y".repeat(100)}`;
    const result = await channel.send({ chatId: DM_GUID, text: longText, replyTo: "guid-target" });

    const outbound = requests().filter((r) => r.method === "send" || r.method === "send.rich");
    expect(outbound.length).toBeGreaterThan(1);
    expect(outbound.every((r) => r.method === "send")).toBe(true);
    expect(result).toEqual({ threaded: false });
    await channel.stop();
  });

  it("reports the drop when there was no text to carry the target at all", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const result = await channel.send({ chatId: DM_GUID, text: "", replyTo: "guid-target" });

    expect(requests().filter((r) => r.method === "send" || r.method === "send.rich")).toHaveLength(0);
    expect(result).toEqual({ threaded: false });
    await channel.stop();
  });

  it("says nothing about threading when no reply target was requested", async () => {
    const { channel } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    expect(await channel.send({ chatId: DM_GUID, text: "plain" })).toBeUndefined();
    await channel.stop();
  });

  it("says nothing about threading when only an effect could not be applied", async () => {
    // An effect is a delivery property, not a target the caller can reoffer:
    // SendResult reports `replyTo` drops only.
    const { channel } = makeChannel({ caps: CAPS_BASIC });
    await channel.start();

    expect(await channel.send({ chatId: DM_GUID, text: "boom", effect: "impact" })).toBeUndefined();
    await channel.stop();
  });
});

/**
 * P2-2 (#292's third review): a captioned photo left a threadable turn
 * unthreaded. Text threading (`send.rich`) and attachment threading
 * (`send.attachment`) are SEPARATE bridge surfaces, so an imsg too old for the
 * latter can still thread the caption. And for a final one-block
 * `caption + MEDIA:path` the caption is the last message of the turn — there
 * is no later send for the pipeline to reoffer the target to, so a target
 * dropped here is a turn that ends unthreaded for no reason.
 */
describe("imsg captioned photo hands an unapplied reply target to the caption", () => {
  const withPhoto = async (fn: (photoPath: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-caption-reply-"));
    const photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake-png-bytes");
    try {
      await fn(photoPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("threads the caption via send.rich when only send.attachment is missing", async () => {
    await withPhoto(async (photoPath) => {
      // CAPS_FULL: bridge up and threading text, but no attachment surface.
      const { channel, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "caption", replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send", "send.rich"]);
      expect(outbound[0].params).toEqual({ chat_guid: DM_GUID, file: photoPath });
      expect(outbound[1].params).toMatchObject({ chat_guid: DM_GUID, text: "caption", reply_to: "guid-target" });
      // The turn IS threaded — the caller must not reoffer a spent target.
      expect(result?.threaded).not.toBe(false);
      await channel.stop();
    });
  });

  it("reports the drop when the bridge cannot thread the photo OR the caption", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_BASIC });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "caption", replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send", "send"]);
      expect(outbound[1].params).toEqual({ chat_guid: DM_GUID, text: "caption" });
      expect(result).toEqual({ threaded: false });
      await channel.stop();
    });
  });

  it("reports the drop when the caption's own send.rich is refused", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({
        caps: CAPS_FULL,
        responder: (req, child) => {
          if (req.method === "watch.subscribe") return child.respond(req.id, { subscription: 1 });
          if (req.method === "send.rich") return child.respondError(req.id, -32603, "Internal error", "bridge not running");
          child.respond(req.id, { ok: true });
        },
      });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "caption", replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send", "send.rich", "send"]);
      expect(result).toEqual({ threaded: false });
      await channel.stop();
    });
  });

  it("leaves the caption plain when the photo itself took the target", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
      await channel.start();

      const result = await channel.send({ chatId: DM_GUID, photo: photoPath, text: "caption", replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      // One reply per turn: the picture is it, so the caption stays plain.
      expect(outbound.map((r) => r.method)).toEqual(["send.attachment", "send"]);
      expect(outbound[1].params).toEqual({ chat_guid: DM_GUID, text: "caption" });
      expect(result?.threaded).not.toBe(false);
      await channel.stop();
    });
  });
});

/**
 * The pipeline and the channel wired together, because the P2-2 regression
 * lived exactly in the seam: the pipeline decided the photo had taken the
 * reply target while the channel threw it away, so NEITHER the photo nor the
 * text after it was threaded. A turn that asks to thread must end with
 * something threaded whenever the channel can thread anything at all.
 */
describe("imsg + delivery pipeline: a threaded turn always lands somewhere", () => {
  const pipeline = new DeliveryPipeline({ queuePendingErrorNote: () => {} });

  /** Ship a turn's blocks through ONE per-turn sender, as they complete. */
  const deliverBlocks = async (
    channel: Parameters<typeof pipeline.createBlockSender>[0],
    chatId: string,
    blocks: string[],
    options: { replyTo?: string } = {},
  ) => {
    const sender = pipeline.createBlockSender(channel, chatId, options);
    for (const block of blocks) await sender.deliver(block);
  };

  const withPhoto = async (fn: (photoPath: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-e2e-"));
    const photoPath = join(dir, "pic.png");
    writeFileSync(photoPath, "fake-png-bytes");
    try {
      await fn(photoPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("threads the photo of [MEDIA, B] and leaves B plain", async () => {
    await withPhoto(async (photoPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
      await channel.start();

      await deliverBlocks(channel, DM_GUID, [`MEDIA:${photoPath}`, "B"], { replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send.attachment", "send"]);
      expect(outbound[0].params).toMatchObject({ file: photoPath, reply_to: "guid-target" });
      expect(outbound[1].params).toEqual({ chat_guid: DM_GUID, text: "B" });
      await channel.stop();
    });
  });

  it("threads B instead when the bridge cannot thread the photo", async () => {
    await withPhoto(async (photoPath) => {
      // CAPS_FULL threads text (send.rich) but has no attachment surface.
      const { channel, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();

      await deliverBlocks(channel, DM_GUID, [`MEDIA:${photoPath}`, "B"], { replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send", "send.rich"]);
      expect(outbound[0].params).toEqual({ chat_guid: DM_GUID, file: photoPath });
      expect(outbound[1].params).toMatchObject({ text: "B", reply_to: "guid-target" });
      await channel.stop();
    });
  });

  it("threads B after an unthreadable sticker", async () => {
    await withPhoto(async (stickerPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ALL });
      await channel.start();

      await deliverBlocks(channel, DM_GUID, [`STICKER:${stickerPath}`, "B"], { replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.sticker"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send.sticker", "send.rich"]);
      expect(outbound[0].params).toEqual({ chat_guid: DM_GUID, file: stickerPath });
      expect(outbound[1].params).toMatchObject({ text: "B", reply_to: "guid-target" });
      await channel.stop();
    });
  });

  it("threads the caption of a FINAL one-block caption + MEDIA, which has no next send", async () => {
    await withPhoto(async (photoPath) => {
      // The hard case: one block, so the pipeline makes exactly one
      // channel.send call and there is no later message to reoffer the target
      // to. CAPS_FULL cannot thread the picture but can thread the caption,
      // so the turn must still end threaded.
      const { channel, requests } = makeChannel({ caps: CAPS_FULL });
      await channel.start();

      await deliverBlocks(channel, DM_GUID, [`caption\nMEDIA:${photoPath}`], { replyTo: "guid-target" });

      const outbound = requests().filter((r) => ["send", "send.rich", "send.attachment"].includes(r.method));
      expect(outbound.map((r) => r.method)).toEqual(["send", "send.rich"]);
      expect(outbound[0].params).toEqual({ chat_guid: DM_GUID, file: photoPath });
      expect(outbound[1].params).toMatchObject({ text: "caption", reply_to: "guid-target" });
      await channel.stop();
    });
  });

  // A missing attachment file must not swallow its caption: the channel throws
  // AttachmentUnreadableError (above) and the pipeline delivers the caption as
  // text and records only the picture as failed.
  it("delivers the caption as text, threads it, and records only the picture as failed", async () => {
    await withPhoto(async (mediaPath) => {
      const { channel, requests } = makeChannel({ caps: CAPS_ATTACHMENT });
      await channel.start();
      // The window the fix is about: the file exists at the pipeline's check
      // and is gone by the time the channel looks.
      const send = channel.send.bind(channel);
      vi.spyOn(channel, "send").mockImplementation(async (message) => {
        if (message.photo) rmSync(message.photo, { force: true });
        return send(message);
      });
      const sender = pipeline.createBlockSender(channel, DM_GUID, { replyTo: "reply-target-guid" });
      const block = `Here's the chart\nMEDIA:${mediaPath}`;

      const err = await sender.deliver(block).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PartialDeliveryError);

      // The caption is the turn's last chance at the reply target.
      const rich = requests().find((r) => r.method === "send.rich");
      expect(rich?.params).toMatchObject({ text: "Here's the chart", reply_to: "reply-target-guid" });
      expect(requests().filter((r) => r.method === "send.rich" || r.method === "send")).toHaveLength(1);
      expect(requests().some((r) => r.method === "send.attachment")).toBe(false);
      expect(failedDeliveryEntry(block, err)).toBe(`Here's the chart\n${DELIVERY_FAILED_MARKER}MEDIA:${mediaPath}`);
      await channel.stop();
    });
  });

  it("records the picture as delivered when only its separate caption send was refused", async () => {
    // imsg ships a captioned picture as two RPCs. If the attachment resolves
    // and the caption is refused, the channel reports the picture shipped
    // (PartialSendError) and the pipeline must not un-deliver it. The refusal
    // is definite, so the caption is retried as text — refused again here —
    // and it alone is recorded as failed.
    await withPhoto(async (mediaPath) => {
      const { channel, requests } = makeChannel({
        caps: CAPS_ATTACHMENT,
        responder: (req, child) => {
          // Refuse every TEXT send (a definite RPC refusal); accept the file.
          if (typeof req.params.text === "string" && !req.params.file) return child.respondError(req.id, -32000, "refused");
          defaultResponder(req, child);
        },
      });
      await channel.start();
      const sender = pipeline.createBlockSender(channel, DM_GUID);
      const block = `Here's the chart\nMEDIA:${mediaPath}`;

      const err = await sender.deliver(block).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PartialDeliveryError);

      expect(requests().filter((r) => r.method === "send" && r.params.file === mediaPath)).toHaveLength(1);
      expect(failedDeliveryEntry(block, err)).toBe(`${DELIVERY_FAILED_MARKER}Here's the chart\nMEDIA:${mediaPath}`);
      await channel.stop();
    });
  });
});

// --- RPC param-name contract (guards against field-name drift vs the imsg CLI) ---
// Unit-test mocks don't know imsg's real field names, so a rename (e.g. the
// tapback `reaction`→`kind` dogfood bug) can pass tests while silently
// misbehaving on-device. Every outbound RPC's EXACT params are asserted with
// `toEqual` where its behaviour is tested, against the verified v0.12.3 imsg
// handler contract: plain send ("reports the drop when the bridge is down"),
// send with a file and send.attachment (threaded photo describe), send.sticker
// (sticker sends), and tapback / message.unsend / message.edit / group.rename /
// read (imsg-actions.test.ts). The three below have no such home, so their key
// sets are pinned here.

describe("imsg outbound RPC param-name contract", () => {
  const keysOf = (requests: () => RpcRequest[], method: string) =>
    Object.keys(requests().find((r) => r.method === method)?.params ?? {}).sort();

  it("send.rich (threaded reply) → chat_guid, part_index, reply_to, text", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    await channel.send({ chatId: DM_GUID, text: "hi", replyTo: "guid-target" });
    expect(keysOf(requests, "send.rich")).toEqual(["chat_guid", "part_index", "reply_to", "text"]);
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

  it("watch.subscribe → attachments, convert_attachments, include_reactions", async () => {
    // A resumed watch adds since_rowid: "does NOT advance the cursor when
    // dispatch throws, so the row replays" (imsg-inbound.test.ts).
    const { channel, requests } = makeChannel();
    await channel.start();
    expect(keysOf(requests, "watch.subscribe")).toEqual(["attachments", "convert_attachments", "include_reactions"]);
    await channel.stop();
  });
});

// --- Bare-handle targets ------------------------------------------------------
//
// imsg's `send` takes EITHER `chat_guid` (a chat selector) OR `to` (a phone
// number / email) — never both, and no bridge op accepts `to` at all. The
// identity config binds the bare handle, and that form reaches the adapter
// for fixed iMessage reply policies, cron/proactive sends before any inbound
// iMessage, and raw `imessage:+1…` targets. Sending it as `chat_guid` was a
// guaranteed "chat not found".

describe("imsg bare-handle targets", () => {
  const HANDLE = "+15551234567";

  it("sends plain text to a bare handle via `to`, never `chat_guid`", async () => {
    const { channel, requests } = makeChannel();
    await channel.start();

    await channel.send({ chatId: HANDLE, text: "hello" });

    const sends = requests().filter((r) => r.method === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0].params).toEqual({ to: HANDLE, text: "hello" });
    await channel.stop();
  });

  it("degrades a threaded/effect send to a plain `to` send when no chat GUID is known", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const result = await channel.send({ chatId: HANDLE, text: "threaded?", replyTo: "guid-target", effect: "confetti" });

    const methods = requests().map((r) => r.method);
    expect(methods).not.toContain("send.rich");
    expect(requests().find((r) => r.method === "send")?.params).toEqual({ to: HANDLE, text: "threaded?" });
    // The reply target did not go with it — report the drop.
    expect(result).toEqual({ threaded: false });
    await channel.stop();
  });

  it("resolves a bare handle to the conversation GUID once one has been seen, so rich sends work", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    channel.onMessage(vi.fn(async () => true));

    children[0].notifyMessage(inboundMessage({ chat_guid: DM_GUID, sender: HANDLE }));
    await settle();

    await channel.send({ chatId: HANDLE, text: "threaded!", replyTo: "guid-target" });

    const rich = requests().find((r) => r.method === "send.rich");
    expect(rich?.params).toMatchObject({ chat_guid: DM_GUID, reply_to: "guid-target" });
    expect(requests().some((r) => r.method === "send" && "to" in r.params)).toBe(false);
    await channel.stop();
  });

  it("sends a plain attachment to a bare handle via `to`", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-handle-"));
    const file = join(dir, "pic.png");
    writeFileSync(file, "png");
    try {
      await channel.send({ chatId: HANDLE, text: "", photo: file, replyTo: "guid-target" });
      const methods = requests().map((r) => r.method);
      expect(methods).not.toContain("send.attachment");
      expect(requests().find((r) => r.method === "send")?.params).toEqual({ to: HANDLE, file });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await channel.stop();
    }
  });

  it("degrades typing to a no-op for a bare handle with no known conversation", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    const stopTyping = channel.startTyping(HANDLE);
    await settle();
    await stopTyping();

    expect(requests().map((r) => r.method)).not.toContain("typing");
    await channel.stop();
  });

  it("refuses bridge-only ops for a bare handle with no known conversation, with a clear error", async () => {
    const { channel, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();

    await expect(channel.reactToMessage(HANDLE, "msg-guid", "love")).rejects.toThrow(/bare handle/);
    await expect(channel.unsendMessage(HANDLE, "msg-guid")).rejects.toThrow(/bare handle/);
    expect(requests().map((r) => r.method)).not.toContain("tapback");
    expect(requests().map((r) => r.method)).not.toContain("message.unsend");
    await channel.stop();
  });

  it("routes bridge-only ops for a bare handle through the resolved conversation GUID", async () => {
    const { channel, children, requests } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    channel.onMessage(vi.fn(async () => true));

    children[0].notifyMessage(inboundMessage({ chat_guid: DM_GUID, sender: HANDLE }));
    await settle();

    await channel.reactToMessage(HANDLE, "msg-guid", "love");
    expect(requests().find((r) => r.method === "tapback")?.params).toMatchObject({ chat_guid: DM_GUID });
    await channel.stop();
  });
});
