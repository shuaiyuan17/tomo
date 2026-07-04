import { describe, it, expect } from "vitest";
import { filterScaffoldLeak } from "../src/agent/scaffold-filter.js";

describe("filterScaffoldLeak", () => {
  describe("end_of_dialog sentinel line", () => {
    it("strips from a bare end_of_dialog line onward", () => {
      const r = filterScaffoldLeak("See you tomorrow!\nend_of_dialog\nUser: thanks");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("See you tomorrow!");
    });

    it("strips underscore variants and is case-insensitive", () => {
      for (const marker of ["_end_of_dialog", "end_of_dialog_", "_end_of_dialog_", "END_OF_DIALOG"]) {
        const r = filterScaffoldLeak(`done.\n${marker}`);
        expect(r.filtered).toBe(true);
        expect(r.text).toBe("done.");
      }
    });

    it("tolerates surrounding whitespace on the marker line", () => {
      const r = filterScaffoldLeak("done.\n  _end_of_dialog_  \nmore scaffold");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("done.");
    });

    it("does NOT touch the token mid-sentence", () => {
      const text = "The old transcripts contain an end_of_dialog marker we should strip.";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch a line with extra words around the token", () => {
      const text = "note: end_of_dialog is a scaffold token";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch similar but different tokens", () => {
      const text = "ends_of_dialogs\nend of dialog\nfriend_of_dialog";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });
  });

  describe("narrator paragraph", () => {
    it("strips a trailing paragraph starting with the narrator phrase", () => {
      const r = filterScaffoldLeak("Here's the recipe you asked for.\n\nNow the user turns to you and asks about dessert.");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("Here's the recipe you asked for.");
    });

    it("strips when the whole message is the narrator paragraph", () => {
      const r = filterScaffoldLeak("Now the user turns to you and says hello.");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("");
    });

    it("does NOT touch the phrase mid-paragraph", () => {
      const text = "In the play, the actor pauses. Now the user turns to you is not how I'd phrase it.";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch the phrase mid-sentence on a continuation line (no blank line)", () => {
      const text = "First line of thought\nNow the user turns to you — that's the scaffold wording we filter.";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });
  });

  it("cuts at the earliest marker when both appear", () => {
    const r = filterScaffoldLeak("Real reply.\n\nend_of_dialog\n\nNow the user turns to you again.");
    expect(r.filtered).toBe(true);
    expect(r.text).toBe("Real reply.");
  });

  it("leaves ordinary messages untouched", () => {
    for (const text of [
      "Dinner at 7 works. See you then!",
      "NO_REPLY",
      "Multi\n\nparagraph\n\nmessage with no scaffold.",
      "",
    ]) {
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    }
  });
});
