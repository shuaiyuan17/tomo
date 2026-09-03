import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { canonicalTimeZone, formatZonedClock, isValidTimeZone, validTimeZone } from "../src/timezone.js";
import { log } from "../src/logger.js";

// ---------------------------------------------------------------------------
// The time zone gate every people-registry surface goes through. Two things
// matter here: nothing unusable ever gets past it, and every reading comes
// from the platform tz database rather than from arithmetic on a stored
// offset — which is what makes daylight saving somebody else's problem.
// ---------------------------------------------------------------------------

describe("time zone validation", () => {
  it("canonicalizes region identifiers, including case and regional aliases", () => {
    expect(canonicalTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(canonicalTimeZone("asia/tokyo")).toBe("Asia/Tokyo");
    expect(canonicalTimeZone("  America/New_York  ")).toBe("America/New_York");
    // A regional alias resolves to its canonical zone and is accepted.
    expect(canonicalTimeZone("US/Pacific")).toBe("America/Los_Angeles");
  });

  it("accepts the ordinary region zones people actually live in", () => {
    for (const zone of [
      "Asia/Shanghai", "America/Los_Angeles", "Australia/Adelaide", "Asia/Kolkata",
      "Europe/Berlin", "Africa/Cairo", "Pacific/Auckland", "America/Argentina/Buenos_Aires",
    ]) {
      expect(isValidTimeZone(zone), `${zone} should be accepted`).toBe(true);
    }
  });

  it("rejects junk, blanks, and missing values without throwing", () => {
    expect(canonicalTimeZone("Not/AZone")).toBeUndefined();
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(canonicalTimeZone("")).toBeUndefined();
    expect(canonicalTimeZone("   ")).toBeUndefined();
    expect(canonicalTimeZone(undefined)).toBeUndefined();
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
  });

  // Intl accepts every one of these, and they are exactly the values that
  // quietly sit an hour wrong for half the year.
  it("rejects fixed-offset forms even though Intl accepts them", () => {
    expect(canonicalTimeZone("+09:00")).toBeUndefined();
    expect(canonicalTimeZone("-05:00")).toBeUndefined();
  });

  it("rejects the legacy all-caps aliases, which carry no DST rules", () => {
    // The dangerous case: ICU resolves `EST` to `America/Panama`, a zone that
    // never observes daylight saving, so a record meaning "New York" would
    // read an hour wrong every summer while looking perfectly healthy. The
    // check is on the RAW value, because that canonicalization is
    // ICU-version dependent.
    for (const zone of ["EST", "MST", "HST", "EST5EDT", "CST6CDT", "PST8PDT", "GMT", "UTC", "Zulu"]) {
      expect(canonicalTimeZone(zone), `${zone} should be rejected`).toBeUndefined();
    }
  });

  it("rejects the Etc/ namespace, offsets by construction", () => {
    for (const zone of ["Etc/GMT+8", "Etc/GMT-8", "Etc/UTC", "Etc/Zulu", "etc/gmt+8"]) {
      expect(canonicalTimeZone(zone), `${zone} should be rejected`).toBeUndefined();
    }
  });

  it("degrades an unusable value to undefined on the read path", () => {
    expect(validTimeZone("Not/AZone", { person: "Alice Example" })).toBeUndefined();
    expect(validTimeZone(undefined)).toBeUndefined();
    expect(validTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});

describe("formatZonedClock", () => {
  it("renders the wall clock of the requested zone", () => {
    // 2026-09-03T03:50Z
    const instant = new Date(Date.UTC(2026, 8, 3, 3, 50));
    expect(formatZonedClock(instant, "UTC")).toBe("09/03 03:50 UTC");
    expect(formatZonedClock(instant, "Asia/Tokyo")).toBe("09/03 12:50 GMT+9");
    // Crosses back over the date line into the previous day.
    expect(formatZonedClock(instant, "America/New_York")).toBe("09/02 23:50 EDT");
  });

  it("follows daylight saving through the tz database, not a stored offset", () => {
    // Same zone, same wall-clock hour, six months apart: the UTC instants are
    // an hour apart and the abbreviation changes. Anything computing from a
    // fixed offset would put one of these an hour out.
    const winter = new Date(Date.UTC(2026, 0, 15, 17, 0));
    const summer = new Date(Date.UTC(2026, 6, 15, 16, 0));
    expect(formatZonedClock(winter, "America/New_York")).toBe("01/15 12:00 EST");
    expect(formatZonedClock(summer, "America/New_York")).toBe("07/15 12:00 EDT");
  });

  it("falls back to the host zone when none is given", () => {
    const instant = new Date(Date.UTC(2026, 8, 3, 3, 50));
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(formatZonedClock(instant)).toBe(formatZonedClock(instant, host));
  });
});

// The memo of already-warned values is module state, so this runs last: it
// fills the memo to its ceiling and everything above would otherwise see a
// registry that has already used up its warning budget.
describe("warn-once memo under a flood of bad values", () => {
  const warnCount = () => vi.mocked(log.warn).mock.calls.length;

  it("warns a bounded number of times and never re-warns a value it has seen", () => {
    // Comfortably past the cap: the old implementation cleared the whole memo
    // here, so the SECOND pass warned all over again — a log storm on every
    // render, which is exactly what "log once" was supposed to prevent.
    const values = Array.from({ length: 260 }, (_, i) => `Not/AZone${i}`);

    const before = warnCount();
    for (const v of values) expect(validTimeZone(v)).toBeUndefined();
    const afterFirstPass = warnCount() - before;
    expect(afterFirstPass).toBeGreaterThan(0);
    // Bounded by the cap plus the single suppression notice.
    expect(afterFirstPass).toBeLessThanOrEqual(201);

    const beforeSecondPass = warnCount();
    for (const v of values) expect(validTimeZone(v)).toBeUndefined();
    expect(warnCount() - beforeSecondPass).toBe(0);

    // And a third pass, to be explicit that this does not decay over time.
    for (const v of values) validTimeZone(v);
    expect(warnCount() - beforeSecondPass).toBe(0);
  });

  it("says once that further warnings are suppressed", () => {
    const notices = vi.mocked(log.warn).mock.calls.filter(
      ([, message]) => typeof message === "string" && message.includes("further invalid timezone warnings are suppressed"),
    );
    expect(notices).toHaveLength(1);
  });
});
