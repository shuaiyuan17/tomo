import { describe, it, expect, vi, afterEach } from "vitest";

// scaffold-filter reads config.showThinking at call time for its default.
// Stub the config module so tests don't need a populated ~/.tomo/config.json
// (CI has neither that nor the channel env vars, so real buildConfig() throws).
const mockConfig = vi.hoisted(() => ({ showThinking: false }));
vi.mock("../src/config.js", () => ({ config: mockConfig }));

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


  // -------------------------------------------------------------------------
  // Tool-call debris: a bare `count` sentinel line.
  //
  // Real shape, measured over 312 assistant text blocks in the local session
  // transcripts and 30,898 sent iMessages: 155 blocks / 1,137 sent messages
  // end with a line that is byte-exactly `count`. In 155/155 transcript cases
  // it is the LAST non-empty line. Never padded, never capitalised, never
  // mid-block.
  //
  // `count` is an ordinary English word, so the NEAR-MISS cases below are the
  // ones that matter: a filter that silently eats real text is worse than the
  // leak it fixes.
  describe("bare `count` sentinel", () => {
    it("strips a trailing bare count line, preserving the reply verbatim", () => {
      const r = filterScaffoldLeak("查一下 —— 它是死代码还是还接着线\n\ncount");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("查一下 —— 它是死代码还是还接着线");
    });

    it("strips when the whole block is the sentinel", () => {
      const r = filterScaffoldLeak("count");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("");
    });

    it("strips when blank lines trail the sentinel", () => {
      const r = filterScaffoldLeak("done.\n\ncount\n\n");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("done.");
    });

    it("tolerates trailing spaces on the sentinel line", () => {
      expect(filterScaffoldLeak("done.\ncount  ").text).toBe("done.");
    });

    // --- near-miss guards: every one of these MUST survive untouched ---

    it("does NOT touch a --count shell flag", () => {
      const text = "跑这个数一下:\n\ngit rev-list --count HEAD";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch a line that merely ENDS with --count", () => {
      const text = "$ git rev-list --count\n136";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch a sentence whose last word is count", () => {
      for (const text of [
        "the count was 136",
        "136 条 / 22 天。这是我记下来的 count",
        "Earth Rated Pet Wipes, Unscented, 400 Count",
      ]) {
        expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
      }
    });

    it("does NOT touch tokens that merely contain or start with count", () => {
      for (const text of ["countdown", "freshTailCount", "- freshTailCount: 256", "descendantcount"]) {
        expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
      }
    });

    it("does NOT touch a capitalised Count on its own trailing line", () => {
      const text = "column headers:\nCount";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch an INDENTED count line (code block)", () => {
      const text = "the struct is:\n\n    id\n    count";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch a bare count line that is not the last line", () => {
      const text = "pasted output:\n\ncount\n136\n\nso 136 commits.";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });
  });

  // -------------------------------------------------------------------------
  // Thinking preamble. Real shape from the transcripts (22 blocks):
  //   思考:<reasoning>。\n\n<more reasoning>。 <the actual reply>
  // Halfwidth colon, always at position 0, reply glued onto the reasoning's
  // last paragraph after a CJK terminator + a single ASCII space.
  describe("thinking preamble", () => {
    it("drops the preamble and keeps the reply after the seam", () => {
      const r = filterScaffoldLeak("思考:好问题。这是可查的,别猜。 查一下 —— 它是死代码还是还接着线");
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("查一下 —— 它是死代码还是还接着线");
    });

    it("handles the real multi-paragraph shape, trailing count included", () => {
      const r = filterScaffoldLeak(
        "思考:有意思——8/24 我已经发现过这个错误了。\n\n所以这不是新发现。\n\n让我看看当时记了什么。 这个错我 8/24 凌晨就抓到过 —— 不是新发现\n\ncount",
      );
      expect(r.filtered).toBe(true);
      expect(r.text).toBe("这个错我 8/24 凌晨就抓到过 —— 不是新发现");
    });

    it("cuts at the FIRST seam, never the last", () => {
      // Failure direction is deliberate: cutting early leaves some reasoning
      // visible (embarrassing but recoverable); cutting late would silently
      // eat the front of the reply (invisible and unrecoverable).
      const r = filterScaffoldLeak("思考:第一段。 第二段。 第三段");
      expect(r.text).toBe("第二段。 第三段");
    });

    // --- near-miss guards: every one of these MUST survive untouched ---

    it("does NOT touch 思考 in ordinary prose", () => {
      for (const text of [
        "像你思考的时候不会先决定「我要思考一下」再思考——是问题本身让你停下来。",
        "- 更强的推理和深度思考",
        "怎么让它放大你的判断力而不是替代你的思考。你已经在做这个了。",
        "去吧,Big Mac + 薯条,今晚不思考。🍔",
        "我回了关于「习惯」这个词本身的思考。然后一个小时的沉默。",
      ]) {
        expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
      }
    });

    it("does NOT touch a FULLWIDTH-colon 思考： opening — that is normal Chinese punctuation", () => {
      const text = "思考：这是一段正常的中文。 后面还有内容";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch 思考: quoted mid-sentence (talking ABOUT the bug)", () => {
      const text = "这三件我都撞到过 —— 今天就漏了好几次「思考:」和「count」出去。 后面还有话";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does NOT touch a message that starts with 思考 but no colon", () => {
      const text = "思考这件事本身就有价值。 我是这么看的";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("returns the block VERBATIM when no seam can be located", () => {
      // 1 of 22 real instances had no seam. Guessing a cut point there would
      // delete text on a hunch — leave it alone and let the leak be visible.
      const text = "思考:我需要先搞清楚现状再派活\n\n但我可以先摸清楚代码";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });

    it("does not treat a CJK terminator without an ASCII space as a seam", () => {
      const text = "思考:第一句。第二句。第三句";
      expect(filterScaffoldLeak(text)).toEqual({ text, filtered: false });
    });
  });

  // -------------------------------------------------------------------------
  // The showThinking switch (config.showThinking / TOMO_SHOW_THINKING) is the
  // SAME mechanism as the thinking filter above, seen from the other side —
  // not a parallel code path. Default is hidden.
  describe("showThinking switch", () => {
    afterEach(() => { mockConfig.showThinking = false; });

    it("keeps the preamble when thinking is shown", () => {
      const text = "思考:好问题。这是可查的,别猜。 查一下";
      expect(filterScaffoldLeak(text, { showThinking: true })).toEqual({ text, filtered: false });
    });

    it("still strips tool-call debris and envelope scaffold when thinking is shown", () => {
      // `count` is debris, not thinking — the switch must not resurrect it.
      expect(filterScaffoldLeak("思考:reasoning。 reply\n\ncount", { showThinking: true }).text)
        .toBe("思考:reasoning。 reply");
      expect(filterScaffoldLeak("reply\nend_of_dialog", { showThinking: true }).text).toBe("reply");
      expect(filterScaffoldLeak("reply\n<system-reminder>x", { showThinking: true }).text).toBe("reply");
    });

    it("defaults to config.showThinking when no option is passed", () => {
      const text = "思考:好问题。这是可查的,别猜。 查一下";
      expect(filterScaffoldLeak(text).text).toBe("查一下");
      mockConfig.showThinking = true;
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
