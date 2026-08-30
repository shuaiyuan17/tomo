import { describe, it, expect } from "vitest";
import { canManageJob, isStorableSessionKey } from "../src/cron/scope.js";

/** Only `sessionKey` matters to the predicate. */
function job(sessionKey?: string) {
  return { sessionKey: sessionKey as string };
}

describe("canManageJob", () => {
  it("lets a session manage its own jobs", () => {
    expect(canManageJob(job("dm:shuai"), "dm:shuai")).toBe(true);
    expect(canManageJob(job("telegram:-100270"), "telegram:-100270")).toBe(true);
  });

  it("lets the owner's DM session manage group-keyed jobs", () => {
    // The MCP server is built for the session the TURN runs on. A summoned
    // group's background turns run on dm:<owner>, while the jobs they manage
    // carry the group key — so without this the owner cannot touch a job they
    // created for their own group.
    expect(canManageJob(job("telegram:-100270"), "dm:shuai")).toBe(true);
    expect(canManageJob(job("imessage:any;+;chat42"), "dm:shuai")).toBe(true);
  });

  it("lets the owner's DM session adopt jobs with no session key", () => {
    // Legacy records and jobs orphaned by a session rewrite would otherwise
    // be administrable by nobody.
    expect(canManageJob(job(undefined), "dm:shuai")).toBe(true);
    expect(canManageJob(job(""), "dm:shuai")).toBe(true);
  });

  it("does not let a group reach outside itself", () => {
    expect(canManageJob(job("dm:shuai"), "telegram:-100270")).toBe(false);
    expect(canManageJob(job("telegram:-100999"), "telegram:-100270")).toBe(false);
    // Not even an unattributed job: a group must never adopt one.
    expect(canManageJob(job(undefined), "telegram:-100270")).toBe(false);
  });

  it("does not let one identity's DM manage another's", () => {
    expect(canManageJob(job("dm:alice"), "dm:shuai")).toBe(false);
  });

  it("is unscoped when no caller is supplied (CLI, tests)", () => {
    expect(canManageJob(job("dm:alice"), undefined)).toBe(true);
  });

  it("requires a canonical dm key before granting owner authority", () => {
    // A structurally wrong key must not buy cross-session powers.
    expect(canManageJob(job("telegram:-100270"), "dm:")).toBe(false);
    expect(canManageJob(job("telegram:-100270"), "dm:alice:extra")).toBe(false);
    expect(canManageJob(job(undefined), "dm:")).toBe(false);
    // A non-slug identity name (names are free-form in config) fails CLOSED:
    // the session keeps its own jobs, it just does not get the extra reach.
    expect(canManageJob(job("telegram:-100270"), "dm:shuai yuan")).toBe(false);
    expect(canManageJob(job("dm:shuai yuan"), "dm:shuai yuan")).toBe(true);
  });

  it("normalises case and surrounding whitespace on the caller key", () => {
    // "Canonical" is checked after trim/lowercase — caller keys come from the
    // harness (the session the turn runs on), never from the model, so this
    // normalisation costs nothing and avoids treating "dm:ALICE" as a
    // different, unprivileged principal.
    expect(canManageJob(job("telegram:-100270"), "dm:ALICE")).toBe(true);
    expect(canManageJob(job("telegram:-100270"), " dm:alice ")).toBe(true);
  });
});

describe("isStorableSessionKey", () => {
  it("accepts the keys the router actually produces", () => {
    expect(isStorableSessionKey("dm:shuai")).toBe(true);
    expect(isStorableSessionKey("telegram:-1001234567")).toBe(true);
    expect(isStorableSessionKey("imessage:any;+;chat123456")).toBe(true);
    // Free-form identity names are legitimate delivery targets even though
    // they earn no owner authority.
    expect(isStorableSessionKey("dm:shuai yuan")).toBe(true);
  });

  it("rejects strings that are not session keys", () => {
    expect(isStorableSessionKey("")).toBe(false);
    expect(isStorableSessionKey("shuai")).toBe(false);          // no channel
    expect(isStorableSessionKey("dm:")).toBe(false);            // no identity
    expect(isStorableSessionKey("telegram:")).toBe(false);      // no chat
    expect(isStorableSessionKey(":123")).toBe(false);           // no channel
    expect(isStorableSessionKey(" dm:shuai")).toBe(false);      // stray space
    expect(isStorableSessionKey("dm:shuai\ntelegram:1")).toBe(false); // newline
    expect(isStorableSessionKey("dm:a:b")).toBe(false);         // smuggled colon
  });
});
