import { describe, expect, it } from "vitest";
import { OwnerRouter } from "../src/router.js";
import { resolveOwner } from "../src/owner.js";
import type { SessionStore } from "../src/sessions/store.js";

// The web channel's admission rule (OwnerRouter.isAllowed). WebChannel and
// Agent.enqueueMessage refuse a non-"owner" chat before this is asked, so the
// router's own check has to be tested directly.
describe("OwnerRouter.isAllowed for the web channel", () => {
  const sessions = {} as SessionStore; // isAllowed("web", …) never reads it
  const owner = resolveOwner({
    owner: undefined,
    identities: [{ name: "shuai", channels: { telegram: "12345" }, replyPolicy: "last-active" }],
    webOwnerIdentity: undefined,
  }).owner;

  it("admits only the owner pseudo-chat", () => {
    const router = new OwnerRouter(owner, sessions, {});
    expect(router.isAllowed("web", "owner")).toBe(true);
    expect(router.isAllowed("web", "someone-else")).toBe(false);
    expect(router.isAllowed("web", "12345")).toBe(false);
  });

  it("admits nothing when there is no owner", () => {
    const router = new OwnerRouter(undefined, sessions, {});
    expect(router.isAllowed("web", "owner")).toBe(false);
  });
});
