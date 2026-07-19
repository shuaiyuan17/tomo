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
