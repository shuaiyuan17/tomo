import { describe, expect, it } from "vitest";
import { deriveOwnerIdentity } from "../src/cli/init.js";

describe("deriveOwnerIdentity", () => {
  it("uses the lowercased first name and binds the Telegram user ID", () => {
    expect(deriveOwnerIdentity("Shuai Yuan", "12345")).toEqual({
      name: "shuai",
      channels: { telegram: "12345" },
      replyPolicy: "last-active",
    });
  });

  it("falls back to \"owner\" when no name was given", () => {
    expect(deriveOwnerIdentity("", "12345").name).toBe("owner");
    expect(deriveOwnerIdentity("   ", "12345").name).toBe("owner");
  });

  it("keeps non-Latin names intact", () => {
    expect(deriveOwnerIdentity("小明", "12345").name).toBe("小明");
  });
});

describe("precreateOwnerSession", () => {
  it("creates the owner's dm: entry once, with no SDK session yet", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { precreateOwnerSession } = await import("../src/cli/init.js");
    const { SessionStore } = await import("../src/sessions/store.js");
    const dir = mkdtempSync(join(tmpdir(), "tomo-init-owner-"));
    try {
      precreateOwnerSession("alex", join(dir, "sessions"), join(dir, "sdk"));
      precreateOwnerSession("alex", join(dir, "sessions"), join(dir, "sdk"));
      const store = new SessionStore(join(dir, "sessions"), 20, join(dir, "sdk"));
      expect(store.listAllSessions().map((e) => [e.channelKey, e.sdkSessionId])).toEqual([["dm:alex", ""]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
