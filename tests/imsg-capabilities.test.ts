import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { type ImsgCapabilities } from "../src/channels/imessage-imsg.js";
import { log } from "../src/logger.js";
import {
  CAPS_FULL,
  CAPS_BASIC,
  makeChannel,
  DM_GUID,
  inboundMessage,
  settle,
  waitFor,
} from "./helpers/fake-imsg.js";

// ImsgChannel tests, split by concern (fakes in tests/helpers/fake-imsg.ts).
// Capability gating: how a closed gate is diagnosed, edit gating, and the
// startup / on-demand capability re-probe.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Capability gate diagnosis ---------------------------------------------
//
// A closed gate must say WHAT it read and WHAT it saw, because a key's
// absence from the probe output is otherwise indistinguishable from "probed
// and refused" — the exact misreading that once had both humans and agents
// concluding "the bridge lacks stickerSend" from a 0.12.x bridge that was
// simply never going to mention it. Provenance the verdicts encode (verified
// against imsg v0.13.4 source): rpc_methods is a static list compiled into
// the CLI (kSupportedRPCMethods); selectors come from the dylib actually
// running inside Messages.app, and 0.13+ dylibs emit every key they know as
// explicit true/false — so ABSENT means "running dylib predates the
// feature" (heals via a real relaunch) while FALSE means "the bridge asked
// the OS and the surface is gone" (nothing heals it).

describe("imsg capability gate diagnosis", () => {
  const stickerFile = async (fn: (stickerPath: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "tomo-imsg-diag-"));
    const stickerPath = join(dir, "dog.jpg");
    writeFileSync(stickerPath, "fake-jpeg-bytes");
    try {
      await fn(stickerPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const diagnosisOf = (spy: ReturnType<typeof vi.spyOn>, message: string) => {
    const call = spy.mock.calls.find((c) => c.some((a) => typeof a === "string" && a.includes(message)));
    expect(call, `expected a log containing "${message}"`).toBeDefined();
    return call![0] as { checked: Record<string, string | boolean>; verdict: string };
  };

  it("names an ABSENT sticker selector and the quit-then-launch remedy (running bridge predates 0.13)", async () => {
    await stickerFile(async (stickerPath) => {
      const infoSpy = vi.spyOn(log, "info");
      // The trap measured live: 0.13.4 CLI (send.sticker in rpc_methods) over
      // a still-resident 0.12.x bridge whose probe never mentions stickerSend.
      const { channel } = makeChannel({
        caps: { ...CAPS_FULL, rpcMethods: new Set([...CAPS_FULL.rpcMethods, "send.sticker"]) },
      });
      await channel.start();
      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const diag = diagnosisOf(infoSpy, "native sticker send unavailable");
      expect(diag.checked).toMatchObject({
        "advancedFeatures": true,
        "rpcMethods.send.sticker": true,
        "selectors.stickerSend": "absent",
      });
      expect(diag.verdict).toMatch(/ABSENT from the bridge's probe/);
      expect(diag.verdict).toMatch(/quit Messages\.app, then `imsg launch`/);
      expect(diag.verdict).toMatch(/no-ops while the old bridge still answers ping/);
      await channel.stop();
    });
  });

  it("blames the installed CLI (static rpc_methods list) when it predates send.sticker", async () => {
    await stickerFile(async (stickerPath) => {
      const infoSpy = vi.spyOn(log, "info");
      // Inverse skew: 0.13+ bridge already injected, old CLI on PATH.
      const { channel } = makeChannel({
        caps: { ...CAPS_FULL, selectors: { ...CAPS_FULL.selectors, stickerSend: true } },
      });
      await channel.start();
      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const diag = diagnosisOf(infoSpy, "native sticker send unavailable");
      expect(diag.checked["rpcMethods.send.sticker"]).toBe(false);
      expect(diag.verdict).toMatch(/static list compiled into the CLI/);
      expect(diag.verdict).toMatch(/upgrade imsg/);
      await channel.stop();
    });
  });

  it("distinguishes a selector the live bridge probed FALSE (OS limit, nothing heals it)", async () => {
    await stickerFile(async (stickerPath) => {
      const infoSpy = vi.spyOn(log, "info");
      const { channel } = makeChannel({
        caps: {
          ...CAPS_FULL,
          rpcMethods: new Set([...CAPS_FULL.rpcMethods, "send.sticker"]),
          selectors: { ...CAPS_FULL.selectors, stickerSend: false },
        },
      });
      await channel.start();
      await channel.send({ chatId: DM_GUID, text: "", sticker: stickerPath });

      const diag = diagnosisOf(infoSpy, "native sticker send unavailable");
      expect(diag.checked["selectors.stickerSend"]).toBe(false);
      expect(diag.verdict).toMatch(/probed FALSE by the live bridge/);
      expect(diag.verdict).toMatch(/no relaunch or upgrade/);
      await channel.stop();
    });
  });

  it("logs the rich-link gate's reads when a bare URL degrades to plain text", async () => {
    const infoSpy = vi.spyOn(log, "info");
    const { channel } = makeChannel({ caps: CAPS_FULL });
    await channel.start();
    await channel.send({ chatId: DM_GUID, text: "https://example.com/a" });

    const diag = diagnosisOf(infoSpy, "rich link preview unavailable");
    expect(diag.checked).toMatchObject({
      "advancedFeatures": true,
      "selectors.urlPreviewMessage": "absent",
      "selectors.sendRichLinkAction": "absent",
    });
    // The rich-link gate reads no rpc_methods entry, so the diagnosis must
    // not claim one.
    expect(Object.keys(diag.checked).some((k) => k.startsWith("rpcMethods."))).toBe(false);
    expect(diag.verdict).toMatch(/ABSENT from the bridge's probe/);
    await channel.stop();
  });

  it("logs the edit gate's reads (selectors probed FALSE on macOS 26) before throwing", async () => {
    // Ground truth for macOS 26.5: editMessageItem and editMessage both
    // probed unavailable — calling message.edit blindly is what #227 was.
    const warnSpy = vi.spyOn(log, "warn");
    const { channel, requests } = makeChannel({ caps: CAPS_FULL }); // editMessageItem/editMessage: false
    await channel.start();
    await expect(channel.editMessage(DM_GUID, "guid-1", "fixed")).rejects.toThrow(/unsupported on this macOS/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");

    const diag = diagnosisOf(warnSpy, "message edit refused by capability gate");
    expect(diag.checked).toMatchObject({
      "rpcMethods.message.edit": true,
      "selectors.editMessageItem": false,
      "selectors.editMessage": false,
      "selectors.editMessageItemTranslation": false,
    });
    expect(diag.verdict).toMatch(/probed FALSE by the live bridge/);
    await channel.stop();
  });
});

// --- Edit gating (Codex LOW #5) -------------------------------------------------

describe("imsg edit gating requires the full capability set", () => {
  // The allowed case (bridge + message.edit + a live selector) is
  // "edits via message.edit when a selector probe confirms support" in
  // imsg-actions.test.ts; the all-selectors-false case is the gate-diagnosis
  // test above.
  it.each<[string, ImsgCapabilities]>([
    ["the bridge is down even if a selector is set", { ...CAPS_FULL, advancedFeatures: false, selectors: { editMessageItem: true } }],
    ["imsg does not advertise message.edit", { ...CAPS_FULL, rpcMethods: new Set(["send", "watch.subscribe"]), selectors: { editMessageItem: true } }],
  ])("refuses when %s", async (_, caps) => {
    const { channel, requests } = makeChannel({ caps });
    await channel.start();
    await expect(channel.editMessage(DM_GUID, "mine-1", "fixed text")).rejects.toThrow(/unsupported on this macOS/i);
    expect(requests().map((r) => r.method)).not.toContain("message.edit");
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
    channel.onMessage(vi.fn(async () => true));

    // The bridge comes up after the (degraded) startup snapshot. The next
    // inbound message still skips the read receipt (cached answer), but its
    // gate kicks a background re-probe.
    bridgeUp = true;
    children[0].notifyMessage(inboundMessage({ id: 100, guid: "reprobe-1" }));
    await waitFor(() => expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2));
    await settle();
    expect(requests().some((r) => r.method === "read")).toBe(false);

    // The refreshed snapshot serves the following message: read goes out.
    children[0].notifyMessage(inboundMessage({ id: 101, guid: "reprobe-2" }));
    await waitFor(() => expect(requests().some((r) => r.method === "read")).toBe(true));
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

    const internals = (channel as unknown as { rpc: { capabilities: ImsgCapabilities } }).rpc;
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
