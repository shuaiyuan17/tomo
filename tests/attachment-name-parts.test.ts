import { describe, expect, it } from "vitest";
import {
  localDateFolder,
  localTimeStamp,
  sanitize,
  shortGuid,
} from "../src/channels/attachment-write.js";

// The name parts every inbound store builds its paths from. imageStore's names
// are reverse-parsed by isImageFiledFor, so these formats are a contract.
describe("attachment name parts", () => {
  it("formats the local date folder and time stamp zero-padded", () => {
    // Local-time constructor, so the assertion holds in any TZ.
    const d = new Date(2026, 0, 5, 3, 4, 9);
    expect(localDateFolder(d)).toBe("2026-01-05");
    expect(localTimeStamp(d)).toBe("030409");
    const late = new Date(2026, 11, 31, 23, 59, 58);
    expect(localDateFolder(late)).toBe("2026-12-31");
    expect(localTimeStamp(late)).toBe("235958");
  });

  it("sanitize keeps [A-Za-z0-9._-], maps the rest to _, falls back on empty", () => {
    expect(sanitize("aZ09._-", "fb")).toBe("aZ09._-");
    expect(sanitize("a/b c:d", "fb")).toBe("a_b_c_d");
    expect(sanitize("../x", "fb")).toBe(".._x");
    expect(sanitize("é", "fb")).toBe("_");
    expect(sanitize("", "fb")).toBe("fb");
    expect(sanitize(undefined, "fb")).toBe("fb");
  });

  it("shortGuid strips dashes, keeps 8 chars, else 'unknown'", () => {
    expect(shortGuid("ab-cd-ef12-3456789")).toBe("abcdef12");
    expect(shortGuid("abc")).toBe("abc");
    expect(shortGuid("---")).toBe("unknown");
    expect(shortGuid(undefined)).toBe("unknown");
  });
});
