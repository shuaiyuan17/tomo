import { describe, it, expect } from "vitest";
import { canManageJob } from "../src/cron/scope.js";

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
});
