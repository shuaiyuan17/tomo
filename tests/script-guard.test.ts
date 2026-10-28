/**
 * Reply script guard: English replies to Chinese messages. Every case below is
 * shaped on a real exchange (2026-10-26 … 10-28).
 */
import { describe, expect, it } from "vitest";
import { inboundScript, replyDrifted, stripNeutral } from "../src/agent/script-guard.js";

const stamp = "[imessage · Wed 10/28 07:05 PDT] ";

describe("inboundScript", () => {
  it("short Chinese is han", () => {
    expect(inboundScript(`${stamp}嗯 今天wfh`)).toBe("han");
  });
  it("mixed Chinese/English is han", () => {
    expect(inboundScript(`${stamp}Under 新proposal，mode还是per run ceiling吗`)).toBe("han");
  });
  it("all-English is latin", () => {
    expect(inboundScript(`${stamp}But on UI, user can see what permission agent now has under "scope" no?`)).toBe("latin");
  });
  it("a bare tapback or link is unknown", () => {
    expect(inboundScript(`${stamp}https://www.apple.com/macbook-pro/`)).toBe("unknown");
    expect(inboundScript(`${stamp}ok`)).toBe("unknown");
  });
  it("the channel stamp itself does not count as English", () => {
    expect(inboundScript(`${stamp}好`)).toBe("han");
  });
});

describe("replyDrifted", () => {
  it("flags an English reply to a Chinese message (10/28 07:05)", () => {
    expect(
      replyDrifted(
        `${stamp}嗯 今天wfh`,
        "Nice, no commute today 😁\n\nGot two quick questions for when you have a sec, no rush.",
      ),
    ).toBe(true);
  });

  it("does not flag a Chinese reply", () => {
    expect(replyDrifted(`${stamp}嗯 今天wfh`, "那正好，不用通勤 😁 有两个小问题想问你，不急。")).toBe(false);
  });

  it("does not flag a Chinese reply that carries a quoted English draft", () => {
    const block =
      '可以贴的短版：\n"This might not be a problem in practice, since Scope already shows the grants. I\'d leave it unless we get questions from users."';
    expect(replyDrifted(`${stamp}写简单一点`, block)).toBe(false);
  });

  it("does not flag an English-only quoted draft when that is the whole reply", () => {
    // He asked for a comment; the reply IS the draft. Quoted, so it is neutral.
    const block = '"This might not be a problem in practice, since Scope already shows the grants."';
    expect(replyDrifted(`${stamp}写简单一点，也许写一个这也许不是问题`, block)).toBe(false);
  });

  it("does not flag English replies to English messages", () => {
    expect(
      replyDrifted(
        `${stamp}But on UI, user can see what permission agent now has under "scope" no?`,
        "Right, if Scope already shows grants then the second layer is visible and that point falls away.",
      ),
    ).toBe(false);
  });

  it("ignores code, URLs and paths in an otherwise Chinese reply", () => {
    const block = "改好了：\n```sh\ngit -C ~/Developer/wayfound worktree remove /Volumes/Claw/wf-xcc-release\n```\nhttps://github.com/shuaiyuan17/wayfound/pull/45";
    expect(replyDrifted(`${stamp}好`, block)).toBe(false);
  });

  it("needs a clear signal: a short English aside is not drift", () => {
    expect(replyDrifted(`${stamp}拿到了！`, "Nice!! 🥹")).toBe(false);
  });

  it("strips fenced and inline code", () => {
    expect(stripNeutral("a `b c` ```\nd\n``` e")).not.toMatch(/[bcd]/);
  });
});
