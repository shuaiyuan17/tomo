import { describe, expect, it } from "vitest";
import {
  ignoredAllowlistDmEntries,
  isDmAllowlistEntry,
  isOwnerHandle,
  ownerDisplayName,
  ownerSessionKey,
  resolveOwner,
  type LegacyIdentity,
} from "../src/owner.js";

const ALEX: LegacyIdentity = {
  name: "Alex",
  channels: { telegram: "123456789", imessage: "+15555550123" },
  replyPolicy: "last-active",
};

describe("resolveOwner (config → owner, never touches data)", () => {
  it("rule 1: an `owner` block wins; identities alongside it are ignored with an info notice", () => {
    const r = resolveOwner({
      owner: { name: "Alex", displayName: "Alexandra", telegram: [123456789], imessage: ["+1 (555) 555-0123", "Alex@Example.com"] },
      identities: [ALEX, { name: "Sam", channels: { telegram: "222" } }],
    });
    expect(r.source).toBe("owner");
    expect(r.owner).toEqual({
      name: "Alex",
      displayName: "Alexandra",
      telegram: ["123456789"],
      imessage: ["+15555550123", "alex@example.com"],
    });
    expect(r.notices).toEqual([{ level: "info", message: expect.stringContaining("`identities` is ignored") }]);
    expect(r.issues).toEqual([]);
  });

  it("accepts a single id as a string and ignores a legacy replyPolicy", () => {
    const r = resolveOwner({ owner: { name: "alex", telegram: "123456789", replyPolicy: "telegram" }, identities: [] });
    expect(r.owner).toEqual({ name: "alex", telegram: ["123456789"], imessage: [] });
  });

  it("an invalid `owner` block is a config issue (the daemon refuses to start), not a silent fallback", () => {
    const r = resolveOwner({ owner: { name: "" }, identities: [ALEX] });
    expect(r.issues.join("\n")).toContain("owner");
  });

  it("rule 2: exactly one identity IS the owner — same name, so the same dm: key", () => {
    const r = resolveOwner({ owner: undefined, identities: [ALEX] });
    expect(r.source).toBe("identity");
    expect(r.owner).toEqual({ name: "Alex", telegram: ["123456789"], imessage: ["+15555550123"] });
    expect(ownerSessionKey(r.owner!)).toBe("dm:alex");
    expect(r.notices).toEqual([]);
  });

  it("rule 2 keeps a non-canonical legacy name byte-for-byte (its key never moves)", () => {
    const r = resolveOwner({ owner: undefined, identities: [{ name: "Alex Example", channels: { telegram: "1" } }] });
    expect(ownerSessionKey(r.owner!)).toBe("dm:alex example");
  });

  it("rule 3: several identities — web.ownerIdentity picks, else the first, with a loud warning", () => {
    const sam: LegacyIdentity = { name: "Sam", channels: { telegram: "222" } };
    const named = resolveOwner({ owner: undefined, identities: [ALEX, sam], webOwnerIdentity: "SAM" });
    expect(named.owner?.name).toBe("Sam");
    expect(named.source).toBe("identities-picked");
    expect(named.notices[0]).toMatchObject({ level: "warn", message: expect.stringContaining("web.ownerIdentity") });

    const first = resolveOwner({ owner: undefined, identities: [ALEX, sam] });
    expect(first.owner?.name).toBe("Alex");
    expect(first.notices[0]).toMatchObject({ level: "warn", message: expect.stringContaining("\"Sam\"") });
    expect(first.notices[0].message).toContain("left untouched");

    const unmatched = resolveOwner({ owner: undefined, identities: [ALEX, sam], webOwnerIdentity: "nobody" });
    expect(unmatched.owner?.name).toBe("Alex");
  });

  it("rule 4: no owner, no identities — adopts the single DM allowlist entry (pre-identity `tomo init` installs)", () => {
    const r = resolveOwner({ owner: undefined, identities: [], allowlists: { telegram: ["123456789", "-100555"] } });
    expect(r.source).toBe("allowlist-adopted");
    expect(r.owner).toEqual({ name: "owner", telegram: ["123456789"], imessage: [] });
    expect(r.notices[0].level).toBe("warn");
  });

  it("rule 4 never guesses between several DM entries, and ignores group identifiers", () => {
    const several = resolveOwner({ owner: undefined, identities: [], allowlists: { telegram: ["111", "222"] } });
    expect(several.owner).toBeUndefined();
    const groupsOnly = resolveOwner({ owner: undefined, identities: [], allowlists: { imessage: ["chat0123456789", "any;+;chatabc"] } });
    expect(groupsOnly.owner).toBeUndefined();
    const oneOfEach = resolveOwner({ owner: undefined, identities: [], allowlists: { telegram: ["111"], imessage: ["+15555550123"] } });
    expect(oneOfEach.owner).toBeUndefined();
  });

  it("rule 5: nothing at all — no owner, with a warning", () => {
    const r = resolveOwner({ owner: undefined, identities: [] });
    expect(r).toMatchObject({ owner: undefined, source: "none" });
    expect(r.notices[0]).toMatchObject({ level: "warn", message: expect.stringContaining("every DM is ignored") });
  });
});

describe("owner helpers", () => {
  const owner = { name: "Alex", telegram: ["123456789"], imessage: ["+15555550123", "alex@example.com"] };

  it("matches owner handles across formatting drift and never matches a group", () => {
    expect(isOwnerHandle(owner, "telegram", "123456789")).toBe(true);
    expect(isOwnerHandle(owner, "telegram", "-100123456789")).toBe(false);
    expect(isOwnerHandle(owner, "imessage", "SMS;-;+15555550123")).toBe(true);
    expect(isOwnerHandle(owner, "imessage", "any;-;ALEX@example.com")).toBe(true);
    expect(isOwnerHandle(owner, "imessage", "+1 (555) 555-0123")).toBe(true);
    expect(isOwnerHandle(owner, "imessage", "any;+;+15555550123")).toBe(false);
    expect(isOwnerHandle(owner, "imessage", "any;-;+15559999999")).toBe(false);
    expect(isOwnerHandle(undefined, "telegram", "123456789")).toBe(false);
    expect(isOwnerHandle(owner, "web", "owner")).toBe(false);
  });

  it("displayName is only a label; the session key comes from name", () => {
    expect(ownerDisplayName({ name: "alex", displayName: "Alexandra" })).toBe("Alexandra");
    expect(ownerDisplayName({ name: "alex" })).toBe("alex");
    expect(ownerSessionKey({ name: "Alex" })).toBe("dm:alex");
  });

  it("classifies allowlist entries", () => {
    expect(isDmAllowlistEntry("telegram", "123456789")).toBe(true);
    expect(isDmAllowlistEntry("telegram", "-100123")).toBe(false);
    expect(isDmAllowlistEntry("imessage", "+15555550123")).toBe(true);
    expect(isDmAllowlistEntry("imessage", "alex@example.com")).toBe(true);
    expect(isDmAllowlistEntry("imessage", "SMS;-;+15555550123")).toBe(true);
    expect(isDmAllowlistEntry("imessage", "any;+;chatabc")).toBe(false);
    expect(isDmAllowlistEntry("imessage", "chat0123456789")).toBe(false);
  });

  it("reports DM allowlist entries that are not the owner (the owner's own entry is harmless)", () => {
    expect(ignoredAllowlistDmEntries(owner, {
      telegram: ["123456789", "222", "-100555"],
      imessage: ["+1 555 555 0123", "+15559999999", "any;+;chatabc"],
    })).toEqual({ telegram: 1, imessage: 1 });
    expect(ignoredAllowlistDmEntries(owner, { telegram: ["123456789"] })).toEqual({});
  });
});
