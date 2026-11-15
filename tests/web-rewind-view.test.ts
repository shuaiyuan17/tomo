import { describe, expect, it } from "vitest";
import { rewindCount, rewindRefusal, rewoundBy, startsRewind } from "../web/src/rewind.js";
import type { WebRewindMark } from "../src/web/protocol.js";

const roles = (...list: Array<"user" | "assistant">) => list.map((role) => ({ role }));

describe("rewind to here: counting and marking", () => {
  it("counts the clicked message and every user message after it; only the owner's own messages can be rewound to", () => {
    const messages = roles("user", "assistant", "user", "user", "assistant");
    expect(rewindCount(messages, 0)).toBe(3);
    expect(rewindCount(messages, 2)).toBe(2);
    expect(rewindCount(messages, 3)).toBe(1);
    expect(rewindCount(messages, 1)).toBeNull();
    expect(rewindCount(messages, 9)).toBeNull();
  });

  it("marks the messages a rewind removed, per conversation, and puts one marker line at the first of them", () => {
    const marks: WebRewindMark[] = [{ sessionId: "a", from: 200, at: 450, count: 2 }];
    const messages = [100, 200, 300, 400, 500].map((timestamp) => ({ timestamp }));
    expect(messages.map((m) => !!rewoundBy(marks, "a", m.timestamp))).toEqual([false, true, true, true, false]);
    expect(messages.map((m) => !!rewoundBy(marks, "b", m.timestamp))).toEqual([false, false, false, false, false]);
    expect(messages.map((_, i) => startsRewind(marks, "a", messages, i))).toEqual([false, true, false, false, false]);
    // Two rewinds back to back each get their own line.
    const two: WebRewindMark[] = [{ sessionId: "a", from: 100, at: 250, count: 1 }, { sessionId: "a", from: 300, at: 450, count: 1 }];
    expect(messages.map((_, i) => startsRewind(two, "a", messages, i))).toEqual([true, false, true, false, false]);
    // The oldest loaded message can be inside a rewind.
    expect(startsRewind(marks, "a", messages.slice(2), 0)).toBe(true);
  });

  it("words every refusal, and says nothing changed for one it does not know", () => {
    for (const code of ["turn_in_flight", "rewind_mismatch", "nothing_to_rewind", "epoch_changed"]) expect(rewindRefusal(code)).toMatch(/^(Not rewound|Tomo restarted)/);
    expect(rewindRefusal("rewind_failed")).toBe("Could not rewind. Nothing was changed; try again.");
    expect(rewindRefusal(undefined)).toContain("Nothing was changed");
  });
});
