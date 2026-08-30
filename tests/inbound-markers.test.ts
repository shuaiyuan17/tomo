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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("logs a warning with the session key and the matched line, and counts it on the bus", () => {
    const markers = detectFabricatedMarkers(`${formatInboundStamp("imessage")} and one more thing`);
    recordFabricatedMarkers("dm:owner", markers);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = vi.mocked(log.warn).mock.calls[0] as [Record<string, unknown>, string];
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
