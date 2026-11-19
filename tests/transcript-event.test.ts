import { describe, it, expect } from "vitest";
import { textOfContent } from "../src/sessions/transcript-event.js";
import { isWarmTailCandidate } from "../src/lcm/blocks.js";

describe("textOfContent", () => {
  it("returns string content as-is, untrimmed", () => {
    expect(textOfContent("  hello  ", " ")).toBe("  hello  ");
  });

  it("joins text blocks with the caller's separator", () => {
    const content = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
    expect(textOfContent(content, " ")).toBe("a b");
    expect(textOfContent(content, "")).toBe("ab");
    expect(textOfContent(content, "\n")).toBe("a\nb");
  });

  it("skips non-text blocks and malformed entries", () => {
    const content = [
      { type: "tool_use", name: "Bash", input: {} },
      null,
      "loose string",
      { type: "text" },
      { type: "text", text: 42 },
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "kept" },
    ];
    expect(textOfContent(content, " ")).toBe("kept");
  });

  it("returns empty for missing or non-text content", () => {
    expect(textOfContent(undefined, " ")).toBe("");
    expect(textOfContent(null, " ")).toBe("");
    expect(textOfContent(42, " ")).toBe("");
    expect(textOfContent({ type: "text", text: "not an array" }, " ")).toBe("");
    expect(textOfContent([], " ")).toBe("");
  });
});

describe("textOfContent legacy options", () => {
  const odd = [
    { type: "text", text: "a" },
    { type: "text" },
    { type: "text", text: null },
    { type: "text", text: 42 },
    { type: "text", text: { x: 1 } },
    { type: "image", text: "no" },
    { type: "text", text: "b" },
  ];

  it("defaults to skipping missing and dropping non-string text", () => {
    expect(textOfContent(odd, "|")).toBe("a|b");
  });

  it("missing: empty keeps a slot for null/undefined text", () => {
    expect(textOfContent(odd, "|", { missing: "empty" })).toBe("a|||b");
  });

  it("nonString: stringify keeps non-string text", () => {
    expect(textOfContent(odd, "|", { nonString: "stringify" })).toBe("a|42|[object Object]|b");
  });

  it("both together match the old `text ?? \"\"` reading", () => {
    expect(textOfContent(odd, "|", { missing: "empty", nonString: "stringify" })).toBe("a|||42|[object Object]|b");
  });
});

describe("blocks keeps its empty separator", () => {
  // With a " " separator two empty text blocks would read as " " — non-empty —
  // and a user turn carrying no words would count toward the warm tail.
  it("a user turn of only empty text blocks is not a warm-tail candidate", () => {
    const event = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "" }, { type: "text", text: "" }] },
    };
    expect(isWarmTailCandidate(event)).toBe(false);
  });

  it("an assistant turn whose only text is non-string still counts as a reply", () => {
    const event = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: 42 }] } };
    expect(isWarmTailCandidate(event)).toBe(true);
  });

});
