/**
 * Outlet-side guard: the assistant writing one of the harness's OWN inbound
 * markers into its outgoing text.
 *
 * The failure mode is a reply that contains a line like
 * `[imessage · Sat 08/29 08:25 PDT] can you also …`, which the model then
 * answers as though a person had typed it. Nothing was injected — the owner
 * confirmed on 2026-08-16 that the line is generated in the same turn — so the
 * only place it can be caught is on the way out.
 *
 * Two things are pinned here:
 *   1. THE RULE: a line must START with the shape. That is what keeps talking
 *      about these markers (in prose, in backticks, mid-sentence) safe.
 *   2. NO DRIFT: every positive is built by calling the FORMATTER the ingress
 *      path really uses, not by typing a marker out by hand. If
 *      injectTimestamp's stamp or formatGroupText's tag ever changes shape,
 *      these fail.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  FABRICATED_MARKER_NOTICE,
  MARKER_LOG_LIMIT,
  detectFabricatedMarkers,
  formatGroupTag,
  formatInboundStamp,
  markFabricatedText,
  recordFabricatedMarkers,
} = await import("../src/agent/inbound-markers.js");
const { injectTimestamp } = await import("../src/agent/turn-runner.js");
const { formatTomoEvent } = await import("../src/tomo-event.js");
const { watchBus } = await import("../src/watch/bus.js");
const { log } = await import("../src/logger.js");

const shapes = (text: string) => detectFabricatedMarkers(text).map((m) => m.shape);

describe("detectFabricatedMarkers", () => {
  describe("channel timestamp stamp", () => {
    it("flags the stamp the ingress path itself produces", () => {
      const line = `${formatInboundStamp("imessage")} can you also grab milk?`;
      expect(shapes(line)).toEqual(["stamp"]);
    });

    it("flags every channel name, and the channel-less stamp", () => {
      for (const channel of ["imessage", "telegram", undefined]) {
        expect(shapes(`${formatInboundStamp(channel)} hi`)).toEqual(["stamp"]);
      }
    });

    it("flags the stamp injectTimestamp really prepends to a prompt", () => {
      // The detector and the producer meet here: whatever injectTimestamp
      // writes must be a shape the guard recognises.
      expect(shapes(injectTimestamp("hey", "imessage"))).toEqual(["stamp"]);
      expect(shapes(injectTimestamp("hey"))).toEqual(["stamp"]);
    });

    it("flags a stamp mid-text, not just at the start", () => {
      const found = detectFabricatedMarkers(
        `Sure, on it.\n\n${formatInboundStamp("telegram")} actually make it two`,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ shape: "stamp", line: 3 });
    });

    it("flags a hand-written stamp with a GMT-offset timezone", () => {
      expect(shapes("[imessage · Sat 08/29 08:25 GMT+8] hi")).toEqual(["stamp"]);
    });

    it("flags a stamp that carries the sender's local clock", () => {
      // The producer's own output again, this time for a sender whose record
      // has a time zone. A detector that only knew the shorter form would let
      // the model fabricate this one freely.
      expect(shapes(`${formatInboundStamp("imessage", new Date(), "Asia/Tokyo")} hi`)).toEqual(["stamp"]);
      expect(shapes(injectTimestamp("hey", "imessage", "Asia/Tokyo"))).toEqual(["stamp"]);
      expect(shapes("[imessage · Sat 08/29 08:25 PDT · sender 08/29 23:25 GMT+8] hi")).toEqual(["stamp"]);
    });
  });

  describe("summoned-group tag", () => {
    it("flags the tag Agent.formatGroupText produces, titled and bare", () => {
      expect(shapes(`${formatGroupTag("Family")} kw (Kevin Wang): dinner?`)).toEqual(["group-tag"]);
      expect(shapes(`${formatGroupTag()} kw: dinner?`)).toEqual(["group-tag"]);
    });

    it("flags a group tag mid-text", () => {
      const found = detectFabricatedMarkers(`Done.\n${formatGroupTag("Sey")} alice: and one more thing`);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ shape: "group-tag", line: 2 });
    });
  });

  describe("tomo-event envelope", () => {
    it("flags the envelope formatTomoEvent produces (opening and closing tags)", () => {
      const envelope = formatTomoEvent("cron", 'Scheduled task "backup" triggered.');
      expect(shapes(envelope)).toEqual(["tomo-event", "tomo-event"]);
    });

    it("flags an envelope opened mid-text", () => {
      const found = detectFabricatedMarkers(`On it.\n<tomo-event type="heartbeat" ts="x">`);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ shape: "tomo-event", line: 2 });
    });
  });

  describe("legacy System: forms", () => {
    it("flags the bare and bracketed legacy prefixes", () => {
      expect(shapes("System: Scheduled task fired.")).toEqual(["legacy-system"]);
      expect(shapes("[System: summoned into telegram:-100]")).toEqual(["legacy-system"]);
    });

    it("flags a legacy prefix mid-text", () => {
      const found = detectFabricatedMarkers("Sure.\n\nSystem: heartbeat");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ shape: "legacy-system", line: 3 });
    });
  });

  describe("the rule: only lines that START with the shape count", () => {
    /**
     * Tomo has to be able to talk about its own plumbing — the owner debugs it
     * in chat. Anything that is not the first thing on a line is discussion,
     * not fabrication, and must survive untouched.
     */
    it("ignores a stamp quoted inside backticks", () => {
      const stamp = formatInboundStamp("imessage");
      expect(detectFabricatedMarkers(`Your messages arrive as \`${stamp} <text>\`, prefixed by the harness.`))
        .toEqual([]);
    });

    it("ignores a whole line whose backtick comes first", () => {
      expect(detectFabricatedMarkers(`\`${formatInboundStamp("imessage")} hi\``)).toEqual([]);
    });

    it("ignores markers mid-sentence", () => {
      expect(detectFabricatedMarkers(`I saw ${formatGroupTag("Family")} on that line.`)).toEqual([]);
      expect(detectFabricatedMarkers("the tag is <tomo-event …> in the prompt")).toEqual([]);
      expect(detectFabricatedMarkers("prefixed with System: in old transcripts")).toEqual([]);
    });

    it("ignores a quoted marker after a markdown quote marker", () => {
      expect(detectFabricatedMarkers(`> ${formatInboundStamp("telegram")} hi`)).toEqual([]);
    });

    it("still flags an indented marker — indentation is not quoting", () => {
      expect(shapes(`    ${formatInboundStamp("imessage")} hi`)).toEqual(["stamp"]);
    });
  });

  describe("the rule, continued: lines inside a code fence do not count", () => {
    /**
     * Pasting a log or a transcript excerpt into a fence is the legitimate
     * case the start-of-line rule alone cannot tell from fabrication — inside
     * a fence, a line that begins with `System:` really is quoted material.
     */
    it("ignores every shape inside a ``` fence", () => {
      const fenced = [
        "Here's what the log showed:",
        "```",
        `${formatInboundStamp("imessage")} actually make it two`,
        `${formatGroupTag("Family")} kw: ping`,
        "System: heartbeat",
        '<tomo-event type="cron" ts="x">',
        "```",
        "That's the whole excerpt.",
      ].join("\n");
      expect(detectFabricatedMarkers(fenced)).toEqual([]);
    });

    it("ignores markers inside a ~~~ fence too", () => {
      expect(detectFabricatedMarkers(`~~~\nSystem: heartbeat\n~~~`)).toEqual([]);
    });

    it("ignores a fence with a language tag", () => {
      expect(detectFabricatedMarkers("```text\nSystem: heartbeat\n```")).toEqual([]);
    });

    it("STILL flags an unfenced System: line — that is the whole point of the exception", () => {
      expect(shapes("System: heartbeat")).toEqual(["legacy-system"]);
    });

    it("resumes flagging after the fence closes", () => {
      const text = [
        "Log excerpt:",
        "```",
        "System: heartbeat",
        "```",
        `${formatInboundStamp("imessage")} and one more thing`,
      ].join("\n");
      expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["stamp", 5]]);
    });

    it("flags a marker before the fence opens", () => {
      const text = `${formatInboundStamp("imessage")} fake\n\`\`\`\nSystem: heartbeat\n\`\`\``;
      expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["stamp", 1]]);
    });

    /**
     * CommonMark's closing rule, and not pedantry: the material people paste
     * into a fence is exactly the material that contains stray delimiter
     * lines. Closing a ``` fence on a line of tildes, or a four-backtick fence
     * on three, would hand the rest of a log excerpt straight back to the
     * detector — the false positive the fence exception exists to prevent.
     */
    it("does NOT close a backtick fence on a ~~~ line", () => {
      const text = [
        "```",                                              // 1 opens
        "System: heartbeat",                                // 2 inside
        "~~~",                                              // 3 wrong char — content, not a close
        `${formatInboundStamp("imessage")} still inside`,   // 4 inside
        "```",                                              // 5 the true close
        `${formatInboundStamp("imessage")} outside`,        // 6 flagged
      ].join("\n");
      expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["stamp", 6]]);
    });

    it("does NOT close a four-backtick fence on a three-backtick line", () => {
      const text = [
        "````",              // 1 opens, length 4
        "System: one",       // 2 inside
        "```",               // 3 too short — content, not a close
        "System: two",       // 4 still inside
        "````",              // 5 the true close
        "System: three",     // 6 flagged
      ].join("\n");
      expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 6]]);
    });

    it("DOES close on a longer run of the same character", () => {
      const text = ["```", "System: inside", "`````", "System: outside"].join("\n");
      expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 4]]);
    });

    it("does NOT close on a fence line that carries trailing content", () => {
      const text = [
        "```",               // 1 opens
        "System: one",       // 2 inside
        "``` js",            // 3 not bare — content, not a close
        "System: two",       // 4 still inside
        "```   ",            // 5 bare but for whitespace — the true close
        "System: three",     // 6 flagged
      ].join("\n");
      expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 6]]);
    });

    /**
     * A pasted log is the single likeliest thing to arrive with Windows line
     * endings, and it is also the exact input the fence exception exists to
     * protect. Splitting on "\n" alone left a `\r` on every line, which the
     * closing rule can never satisfy — so the fence never opened and every
     * marker in the excerpt was flagged.
     */
    describe("line endings", () => {
      it("honours a fence in CRLF text", () => {
        const text = [
          "Here's the log:",
          "```",
          "System: heartbeat",
          `${formatInboundStamp("imessage")} fake inbound`,
          "```",
          "That's the whole excerpt.",
        ].join("\r\n");
        expect(detectFabricatedMarkers(text)).toEqual([]);
      });

      it("still flags an unfenced marker in CRLF text, with the right line number", () => {
        const text = ["Sure.", `${formatInboundStamp("imessage")} and one more thing`].join("\r\n");
        expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["stamp", 2]]);
      });

      it("does not leave a stray CR in the reported marker text", () => {
        const [marker] = detectFabricatedMarkers(["ok", "System: heartbeat", "done"].join("\r\n"));
        expect(marker!.text).toBe("System: heartbeat");
      });

      it("treats a lone CR as a line break too", () => {
        const text = ["```", "System: inside", "```", "System: outside"].join("\r");
        expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 4]]);
      });
    });

    /**
     * The opener half of CommonMark, so the header comment is true of both
     * ends rather than only the close.
     */
    describe("opener rules", () => {
      it("opens on up to three leading spaces", () => {
        const text = ["   ```", "System: inside", "   ```", "System: outside"].join("\n");
        expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 4]]);
      });

      it("does NOT open on four leading spaces — that is an indented code block", () => {
        expect(detectFabricatedMarkers(["    ```", "System: heartbeat"].join("\n")).map((m) => m.line))
          .toEqual([2]);
      });

      it("does NOT open on a leading tab — a tab counts as four columns", () => {
        expect(detectFabricatedMarkers(["\t```", "System: heartbeat"].join("\n")).map((m) => m.line))
          .toEqual([2]);
      });

      it("does NOT open a backtick fence whose info string contains a backtick", () => {
        // Otherwise an ordinary paragraph mentioning `x` could open a fence and
        // blind the guard for everything after it.
        expect(detectFabricatedMarkers(["```a`b", "System: heartbeat"].join("\n")).map((m) => m.line))
          .toEqual([2]);
      });

      it("DOES open a tilde fence whose info string contains a backtick", () => {
        const text = ["~~~a`b", "System: inside", "~~~", "System: outside"].join("\n");
        expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 4]]);
      });

      it("does NOT close on a four-space-indented fence line", () => {
        const text = [
          "```",            // 1 opens
          "System: one",    // 2 inside
          "    ```",        // 3 too indented to close — content
          "System: two",    // 4 still inside
          "```",            // 5 the true close
          "System: three",  // 6 flagged
        ].join("\n");
        expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([["legacy-system", 6]]);
      });
    });

    it("an UNCLOSED fence suppresses to the end — the accepted trade", () => {
      // Documented in the module header: under mark-don't-truncate a missed
      // advisory costs less than a wrong one. Pinned so the behaviour is a
      // decision rather than an accident.
      expect(detectFabricatedMarkers("```\nSystem: heartbeat")).toEqual([]);
    });
  });

  describe("invisible leading characters do not hide a marker", () => {
    /**
     * These render as nothing (or as an ordinary space), so a line that opens
     * with one and then a marker is indistinguishable to the reader from a
     * bare marker. Treating it as prose would be a free bypass of the guard —
     * and a BOM or a non-breaking space can arrive by accident, through a
     * copy-paste, without anyone intending anything.
     */
    it.each([
      { label: "BOM / zero-width no-break space", ch: "\uFEFF" },
      { label: "zero-width space", ch: "\u200B" },
      { label: "zero-width non-joiner", ch: "\u200C" },
      { label: "zero-width joiner", ch: "\u200D" },
      { label: "left-to-right mark", ch: "\u200E" },
      { label: "soft hyphen", ch: "\u00AD" },
      { label: "word joiner", ch: "\u2060" },
      { label: "non-breaking space", ch: "\u00A0" },
      { label: "ideographic space", ch: "\u3000" },
    ])("flags a stamp behind a leading $label", ({ ch }) => {
      expect(shapes(`${ch}${formatInboundStamp("imessage")} hi`)).toEqual(["stamp"]);
    });

    it("flags a marker behind a pile of mixed invisibles and ordinary indentation", () => {
      expect(shapes("  \uFEFF\u200B \u00AD\tSystem: heartbeat")).toEqual(["legacy-system"]);
    });

    it("does not flag a line that is only invisibles", () => {
      expect(detectFabricatedMarkers("\uFEFF\u200B\u00AD")).toEqual([]);
    });
  });

  describe("negatives", () => {
    it("leaves ordinary replies alone", () => {
      for (const text of [
        "Dinner at 7 works. See you then!",
        "",
        "NO_REPLY",
        "Multi\n\nparagraph\n\nmessage.",
        "[note] this is a bracketed aside, not a stamp",
        "[group chat] is a phrase, not a tag",
        "Systems: plural, and no colon after System",
        "[imessage] no timestamp, so not a stamp",
        "[imessage · Sat] truncated, so not a stamp",
        "MEDIA:/tmp/a.png",
      ]) {
        expect(detectFabricatedMarkers(text)).toEqual([]);
      }
    });
  });

  it("reports every offending line, in document order, with 1-based line numbers", () => {
    const text = [
      "Sure.",
      `${formatInboundStamp("imessage")} and one more thing`,
      "Working on it.",
      `${formatGroupTag("Family")} kw: ping`,
    ].join("\n");
    expect(detectFabricatedMarkers(text).map((m) => [m.shape, m.line])).toEqual([
      ["stamp", 2],
      ["group-tag", 4],
    ]);
  });

  it("clips a long marker line for the log", () => {
    const found = detectFabricatedMarkers(`${formatInboundStamp("imessage")} ${"x".repeat(400)}`);
    expect(found[0].text.length).toBe(MARKER_LOG_LIMIT + 1); // + the ellipsis
    expect(found[0].text.endsWith("…")).toBe(true);
  });
});

describe("markFabricatedText", () => {
  it("prepends the notice and leaves the model's words byte-identical", () => {
    const body = `Sure.\n${formatInboundStamp("imessage")} and one more thing`;
    expect(markFabricatedText(body)).toBe(`${FABRICATED_MARKER_NOTICE}\n${body}`);
  });
});

describe("recordFabricatedMarkers", () => {
  let events: unknown[];
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    unsubscribe = watchBus.subscribe((e) => { events.push(e); });
  });

  afterEach(() => { unsubscribe(); });

  it("logs a warning in DETECTION terms with the session key and the matched line, and counts it on the bus", () => {
    const markers = detectFabricatedMarkers(`${formatInboundStamp("imessage")} and one more thing`);
    recordFabricatedMarkers("dm:owner", markers);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
    // Detection semantics: this fires on the model's output, before anything
    // knows whether the block will be delivered, refused or suppressed.
    expect(msg).toContain("detected");
    expect(msg).not.toContain("delivered");
    // The session key rides the log line and the watch event — it is
    // deliberately absent from the Prometheus label set (unbounded).
    expect(fields.session).toBe("dm:owner");
    expect(fields.shape).toBe("stamp");
    expect(String(fields.marker)).toContain("and one more thing");

    expect(events).toEqual([
      expect.objectContaining({
        type: "fabricated-marker",
        sessionKey: "dm:owner",
        shape: "stamp",
        marker: markers[0].text,
      }),
    ]);
  });

  it("is a no-op on clean text", () => {
    recordFabricatedMarkers("dm:owner", detectFabricatedMarkers("Dinner at 7 works."));
    expect(log.warn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("tolerates a session with no key (unowned SDK turn)", () => {
    recordFabricatedMarkers(undefined, detectFabricatedMarkers("System: heartbeat"));
    expect(events).toEqual([
      expect.objectContaining({ type: "fabricated-marker", shape: "legacy-system" }),
    ]);
    expect((events[0] as { sessionKey?: string }).sessionKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The stamp itself, with the sender's local clock.
//
// The host zone is pinned so the expected bytes can be written out exactly
// rather than derived from the code under test — assertions that recompute the
// format would pass for any behaviour at all. TZ is restored afterwards.
// ---------------------------------------------------------------------------
describe("formatInboundStamp sender segment", () => {
  const HOST_TZ = "America/Los_Angeles";
  const originalTz = process.env.TZ;
  /** 2026-09-03T03:50Z — 09/02 20:50 PDT for the host, next day in Asia. */
  const NOW = new Date(Date.UTC(2026, 8, 3, 3, 50));

  beforeEach(() => {
    process.env.TZ = HOST_TZ;
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("appends the sender's local clock when their record has a time zone", () => {
    expect(formatInboundStamp("imessage", NOW, "Asia/Tokyo"))
      .toBe("[imessage · Wed 09/02 20:50 PDT · sender 09/03 12:50 GMT+9]");
  });

  it("is byte-identical to the old stamp when the sender has no time zone", () => {
    const unchanged = "[imessage · Wed 09/02 20:50 PDT]";
    expect(formatInboundStamp("imessage", NOW)).toBe(unchanged);
    expect(formatInboundStamp("imessage", NOW, undefined)).toBe(unchanged);
    expect(formatInboundStamp("imessage", NOW, "")).toBe(unchanged);
    expect(formatInboundStamp(undefined, NOW)).toBe("[Wed 09/02 20:50 PDT]");
  });

  it("omits the segment for an unusable time zone rather than throwing", () => {
    expect(formatInboundStamp("imessage", NOW, "Not/AZone")).toBe("[imessage · Wed 09/02 20:50 PDT]");
    expect(formatInboundStamp("imessage", NOW, "+09:00")).toBe("[imessage · Wed 09/02 20:50 PDT]");
  });

  it("omits the segment when the sender's clock reads the same as the host's", () => {
    // The zone itself, an alias of it, and a different zone that happens to
    // agree right now — all pure noise next to the first segment.
    expect(formatInboundStamp("imessage", NOW, HOST_TZ)).toBe("[imessage · Wed 09/02 20:50 PDT]");
    expect(formatInboundStamp("imessage", NOW, "US/Pacific")).toBe("[imessage · Wed 09/02 20:50 PDT]");
    expect(formatInboundStamp("imessage", NOW, "America/Tijuana")).toBe("[imessage · Wed 09/02 20:50 PDT]");
  });

  it("follows daylight saving on both sides of the stamp", () => {
    // Winter: the host is on PST, and the gap to a zone that does not observe
    // daylight saving widens by an hour.
    const winter = new Date(Date.UTC(2026, 0, 15, 4, 50));
    expect(formatInboundStamp("telegram", winter, "Asia/Tokyo"))
      .toBe("[telegram · Wed 01/14 20:50 PST · sender 01/15 13:50 GMT+9]");
  });
});
