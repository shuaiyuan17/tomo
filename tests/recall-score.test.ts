import { describe, expect, it } from "vitest";
import { RECALL_MAX_SCORED_CHARS, RecallScorer, tokenizeRecallQuery } from "../src/sessions/recall-score.js";

// The scoring behind `recall_conversation` (src/sessions/recall-score.ts).
//
// What it replaced was one test per message: does the lowercased text contain
// the lowercased query as a single substring. `wholeSubstringSearch` below IS
// that test. The cases marked "the substring search misses this" assert both
// halves: the scorer finds the message, and the old test does not. Put the old
// test back behind `search` and those cases fail.

/** Messages are given oldest first; the scorer is fed newest first, as a scan does. */
function search(messages: string[], queries: string | string[], limit = 20) {
  const scorer = new RecallScorer<number>(Array.isArray(queries) ? queries : [queries]);
  for (let i = messages.length - 1; i >= 0; i--) scorer.observe(i, messages[i]);
  const { hits, matched } = scorer.results(limit, (a, b) => b - a);
  return {
    matched,
    texts: hits.map((hit) => messages[hit.item]),
    scoreOf: (text: string) => hits.find((hit) => messages[hit.item] === text)?.score,
    hits: hits.map((hit) => ({ text: messages[hit.item], score: hit.score, matchIndex: hit.matchIndex })),
  };
}

/** The search this module replaced. */
function wholeSubstringSearch(messages: string[], query: string): string[] {
  return messages.filter((text) => text.toLowerCase().includes(query.toLowerCase()));
}

const tokens = (query: string) => tokenizeRecallQuery(query).map((t) => t.text);

/** Unrelated chatter, so that token weights have something to be rare against. */
const FILLER = [
  "今天天气不错，出去走走",
  "晚饭吃什么",
  "The build is green again",
  "明天上午开会",
  "Remember to water the plants",
  "周末去爬山怎么样",
  "I pushed the fix an hour ago",
  "好，就这样",
];

describe("tokenizeRecallQuery", () => {
  it("cuts English into lowercase words of two characters or more", () => {
    expect(tokens("The Ramen place, on 5th & A")).toEqual(["the", "ramen", "place", "on", "5th"]);
  });

  it("cuts Chinese into adjacent two-character pieces", () => {
    expect(tokens("沈阳搬家")).toEqual(["沈阳", "阳搬", "搬家"]);
  });

  it("drops pieces that hold a function character, and a lone function character", () => {
    expect(tokens("搬家的时间")).toEqual(["搬家", "时间"]);
    expect(tokens("猫 的 名字")).toEqual(["猫", "名字"]);
    expect(tokens("是吗")).toEqual([]);
  });

  it("splits where the script changes, with or without spaces", () => {
    expect(tokens("回沈阳的offer")).toEqual(["回沈", "沈阳", "offer"]);
    expect(tokens("iPhone17发布")).toEqual(["iphone17", "发布"]);
  });

  it("keeps each token once", () => {
    expect(tokens("flight flight FLIGHT 机票机票")).toEqual(["flight", "机票", "票机"]);
  });
});

describe("recall scoring", () => {
  it("finds English words in another order (the substring search misses this)", () => {
    const messages = [...FILLER, "The flight to Tokyo got cancelled this morning"];
    const query = "Tokyo flight cancelled";

    expect(search(messages, query).texts).toEqual(["The flight to Tokyo got cancelled this morning"]);
    expect(wholeSubstringSearch(messages, query)).toEqual([]);
  });

  it("finds English words that are apart in the message (the substring search misses this)", () => {
    const messages = [...FILLER, "Booked the ramen spot near the station, the reservation is for Friday at seven"];
    const query = "ramen reservation";

    expect(search(messages, query).texts).toHaveLength(1);
    expect(wholeSubstringSearch(messages, query)).toEqual([]);
  });

  it("finds Chinese words that are apart or reordered (the substring search misses this)", () => {
    const messages = [...FILLER, "搬家公司说时间要改到下周三"];

    for (const query of ["搬家的时间", "时间 搬家", "搬家时间"]) {
      expect(search(messages, query).texts, query).toEqual(["搬家公司说时间要改到下周三"]);
      expect(wholeSubstringSearch(messages, query), query).toEqual([]);
    }
  });

  it("finds a mixed Chinese and English query across spacing and wording (the substring search misses this)", () => {
    const messages = [...FILLER, "沈阳那个 offer 我还在考虑"];
    const query = "回沈阳的offer";

    expect(search(messages, query).texts).toEqual(["沈阳那个 offer 我还在考虑"]);
    expect(wholeSubstringSearch(messages, query)).toEqual([]);
  });

  it("does not count function characters as a match", () => {
    // 的时 is in the second message and 家的 in the third; under plain
    // two-character pieces both would match "搬家的时间" as well as the first.
    const messages = [
      ...FILLER,
      "搬家定在下个月，具体时间再说",
      "到的时候给我打电话",
      "这是大家的决定",
    ];

    expect(search(messages, "搬家的时间").texts).toEqual(["搬家定在下个月，具体时间再说"]);
    // A query that is only function characters falls back to the whole string.
    expect(search(messages, "的").texts).toEqual(["到的时候给我打电话", "这是大家的决定"]);
  });

  it("matches a single word, and only as a whole word", () => {
    const messages = [...FILLER, "that idea is solid", "send me your ID when you can", "the grid is down"];

    expect(search(messages, "id").texts).toEqual(["send me your ID when you can"]);
  });

  it("finds a whole-word occurrence after ones glued into longer words", () => {
    const messages = [...FILLER, "xab ab ab", "aaaaaaaa aa", "abab"];

    expect(search(messages, "ab ab").scoreOf("xab ab ab")).toBeCloseTo(1.5, 5);
    expect(search(messages, "aa").texts).toEqual(["aaaaaaaa aa"]);
  });

  it("scores only the start of a very long message, in bounded time", () => {
    // A megabyte of one letter: every position is an occurrence of "aa"
    // glued into the run. The word after the scored part is not looked for.
    const giant = `${"a".repeat(1_000_000)} zeppelin`;
    const started = performance.now();
    const result = search([...FILLER, giant, "a zeppelin flew by"], ["aa", "zeppelin"]);

    expect(result.texts).toEqual(["a zeppelin flew by"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("counts the messages it scored only in part", () => {
    const scorer = new RecallScorer<number>(["ramen"]);
    scorer.observe(0, "ramen");
    scorer.observe(1, "x".repeat(RECALL_MAX_SCORED_CHARS + 1));

    expect(scorer.clippedMessages).toBe(1);
  });

  it("does not take the first half of a word split by the cut for a whole word", () => {
    // "ramen" ends exactly where the scored part does, and the message goes
    // on with "shop": the word there is "ramenshop".
    const lead = "x ".repeat((RECALL_MAX_SCORED_CHARS - 6) / 2);
    const split = `${lead} ramenshop is open`;
    expect(split.indexOf("ramen") + 5).toBe(RECALL_MAX_SCORED_CHARS);

    expect(search([...FILLER, split], "ramen").texts).toEqual([]);
    // The same word, whole, just before the cut is found.
    expect(search([...FILLER, `${lead}ramen shop is open`], "ramen").texts).toHaveLength(1);
  });

  it("finds an English word that touches Chinese text", () => {
    const messages = [...FILLER, "那个offer的截止日期是周五"];

    expect(search(messages, "offer").texts).toEqual(["那个offer的截止日期是周五"]);
  });

  it("weighs a rare word above a common one", () => {
    // "meeting" is everywhere, "budget" is in two messages. Each of the last
    // two holds one of the query's two words.
    const messages = [
      ...Array.from({ length: 30 }, (_, i) => `meeting notes for day ${i}`),
      "we talked about the budget yesterday",
      "the budget came in under plan",
    ];
    const result = search(messages, "budget meeting", 100);

    const budgetOnly = result.scoreOf("the budget came in under plan");
    expect(budgetOnly).toBeGreaterThan(0.5);
    // The common word alone is under the bar: none of the thirty are kept.
    expect(result.texts).toEqual(["we talked about the budget yesterday", "the budget came in under plan"]);
  });

  it("ranks a full match above a partial one", () => {
    // The partial match holds the rarer of the two words, so it clears the bar.
    const messages = [
      ...FILLER,
      "hair appointment at four",
      "another appointment got cancelled",
      "the dentist called back",
      "moved the dentist appointment to Tuesday",
    ];
    const result = search(messages, "dentist appointment");

    expect(result.texts).toContain("the dentist called back");

    expect(result.scoreOf("moved the dentist appointment to Tuesday"))
      .toBeGreaterThan(result.scoreOf("the dentist called back") ?? Infinity);
    // With room for one, the full match is the one kept.
    expect(search(messages, "dentist appointment", 1).texts).toEqual(["moved the dentist appointment to Tuesday"]);
  });

  it("drops a message that holds only one word of a query with three or more", () => {
    // "renewal" and "form" are common here and "passport" is rare, so the
    // one word the drawer message holds is most of the query's weight: it
    // clears the score bar on its own, and only the two-word rule drops it.
    const messages = [
      ...Array.from({ length: 12 }, (_, i) => `renewal number ${i}`),
      ...Array.from({ length: 12 }, (_, i) => `form number ${i}`),
      "the passport is in the drawer",
      "passport renewal form is due in March",
    ];

    expect(search(messages, "passport renewal form", 100).texts).toEqual(["passport renewal form is due in March"]);
    // Asked with two words, the same message is a match.
    expect(search(messages, "passport renewal", 100).texts).toContain("the passport is in the drawer");
  });

  it("adds a bonus when the whole query appears verbatim", () => {
    const messages = [...FILLER, "appointment with the dentist", "dentist appointment confirmed"];
    const result = search(messages, "dentist appointment");

    expect(result.scoreOf("appointment with the dentist")).toBeCloseTo(1, 5);
    expect(result.scoreOf("dentist appointment confirmed")).toBeCloseTo(1.5, 5);
  });

  it("gives a one-word phrasing the same verbatim bonus as a longer one", () => {
    // Otherwise, of two phrasings, the longer one's exact matches would
    // always outrank the shorter one's.
    const messages = [...FILLER, "ramen tonight?", "the noodle shop is closed"];
    const result = search(messages, ["ramen", "noodle shop"]);

    expect(result.scoreOf("ramen tonight?")).toBeCloseTo(1.5, 5);
    expect(result.scoreOf("the noodle shop is closed")).toBeCloseTo(1.5, 5);
  });

  it("reports the match position in the original text when lowercasing would lengthen it", () => {
    // "İ" lowercases to two code units; forty of them would push an index
    // taken from a plainly lowercased copy forty places past the word.
    const text = `${"İ".repeat(40)} the flight leaves at noon`;
    const [hit] = search([...FILLER, text], "flight noon").hits;

    expect(text.slice(hit.matchIndex, hit.matchIndex + 6)).toBe("flight");

    // The first match is the earliest of several, whichever token it is.
    const later = `${"İ".repeat(40)} at noon the flight leaves`;
    const [second] = search([...FILLER, later], "flight noon").hits;
    expect(later.slice(second.matchIndex, second.matchIndex + 4)).toBe("noon");
  });

  it("lowercases a message the same way whatever else is in it", () => {
    // "ΟΣ" lowercases to "ος" (a final sigma) as a word. An unrelated
    // character that lengthens under lowercasing must not change that.
    const messages = [...FILLER, "İ ΟΣ"];

    expect(search(messages, "ΟΣ").texts).toEqual(["İ ΟΣ"]);
  });

  it("leaves out a two-character piece that straddles two words and appears nowhere", () => {
    // "搬家时间" cuts to 搬家 / 家时 / 时间. 家时 is in no message: it is an
    // artefact of the cutting, not a rare word the message failed to hold, so
    // a message with both real words is a full match.
    const messages = [...FILLER, "搬家公司说时间要改"];

    expect(search(messages, "搬家时间").scoreOf("搬家公司说时间要改")).toBeCloseTo(1, 5);
  });

  it("still counts a word nothing holds against the messages that lack it", () => {
    // Unlike a straddling piece, a whole word the caller typed is part of what
    // was asked for.
    const messages = [...FILLER, "ramen tonight?"];

    expect(search(messages, "ramen zeppelin").scoreOf("ramen tonight?")).toBeCloseTo(0.5, 5);
  });

  it("takes the best score over several phrasings", () => {
    const messages = [...FILLER, "签了租约，下个月一号搬进去"];
    const alone = search(messages, "apartment lease");
    const withSecond = search(messages, ["apartment lease", "租约 搬"]);

    expect(alone.texts).toEqual([]);
    expect(withSecond.texts).toEqual(["签了租约，下个月一号搬进去"]);
    expect(withSecond.scoreOf("签了租约，下个月一号搬进去")).toBeCloseTo(1, 5);
  });

  it("keeps the newer of equally scored messages, and returns them oldest first", () => {
    const messages = ["ramen one", "ramen two", "ramen three", "ramen four"];
    const result = search(messages, "ramen", 2);

    expect(result.texts).toEqual(["ramen three", "ramen four"]);
    expect(result.matched).toBe(4);
  });

  it("reports where the first matched word is", () => {
    const text = `${"x ".repeat(300)}the flight leaves at noon`;
    const [hit] = search([...FILLER, text], "flight noon").hits;

    expect(hit.matchIndex).toBe(text.indexOf("flight"));
  });

  it("matches nothing for blank queries", () => {
    const scorer = new RecallScorer<number>(["", "   "]);
    expect(scorer.isEmpty).toBe(true);
    scorer.observe(0, "anything");
    expect(scorer.results(10, (a, b) => b - a)).toEqual({ hits: [], matched: 0 });
  });
});
