import { describe, it, expect } from "vitest";
import {
  formatTomoEvent,
  parseTomoEvent,
  stripLeadingTomoEvents,
  isHarnessEventText,
  isoTimestampWithOffset,
  type TomoEventType,
} from "../src/tomo-event.js";

describe("formatTomoEvent", () => {
  it("produces the envelope with type and ts", () => {
    const out = formatTomoEvent("heartbeat", "It is Fri. Free time.");
    expect(out).toMatch(/^<tomo-event type="heartbeat" ts="[^"]+">\nIt is Fri\. Free time\.\n<\/tomo-event>$/);
  });

  it("includes the name attribute only when provided", () => {
    expect(formatTomoEvent("cron", "body", { name: "daily-backup" }))
      .toMatch(/^<tomo-event type="cron" name="daily-backup" ts="[^"]+">/);
    expect(formatTomoEvent("cron", "body")).not.toContain("name=");
  });

  it("stamps the given event time as ISO 8601 with a timezone offset", () => {
    const ts = new Date(2026, 6, 4, 9, 5, 2); // local time
    const out = formatTomoEvent("restart", "Restarted. Reason: update", { ts });
    const m = /ts="([^"]+)"/.exec(out);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^2026-07-04T09:05:02[+-]\d{2}:\d{2}$/);
  });

  it("escapes XML-special characters in the name attribute", () => {
    const out = formatTomoEvent("cron", "body", { name: 'say "hi" <now> & leave' });
    expect(out).toContain('name="say &quot;hi&quot; &lt;now&gt; &amp; leave"');
    expect(parseTomoEvent(out)?.name).toBe('say "hi" <now> & leave');
  });
});

describe("isoTimestampWithOffset", () => {
  it("formats with a colon-separated UTC offset", () => {
    expect(isoTimestampWithOffset(new Date(2026, 0, 15, 23, 59, 59)))
      .toMatch(/^2026-01-15T23:59:59[+-]\d{2}:\d{2}$/);
  });
});

describe("parseTomoEvent — round trip per producer type", () => {
  const cases: Array<{ type: TomoEventType; body: string; name?: string }> = [
    { type: "heartbeat", body: "It is Fri, Jul 4, 09:00 PDT. Read CONTINUITY.md.\n\nscript output line 1\nline 2" },
    { type: "restart", body: "Restarted. Reason: config change via /restart" },
    { type: "cron", body: 'Scheduled task "daily-backup" triggered. Run the backup.', name: "daily-backup" },
    { type: "lcm-rollup", body: "An LCM rollup is due. The completed period `daily 2026-07-03` has 42 raw events ready to consolidate.", name: "daily 2026-07-03" },
    { type: "context-nudge", body: "Context usage is at 72% (144000/200000 tokens). Run `tomo lcm prune-tools`.", name: "prune" },
    { type: "summon", body: 'Alice summoned you into the group chat "Dinner" (telegram:-987).', name: "telegram:-987" },
    { type: "summon-reminder", body: 'Summoned-group message. To reply in the group, call send_message with mode "direct".' },
    { type: "summon-expired", body: 'Your summon into the group "Dinner" expired after inactivity.', name: "telegram:-987" },
    { type: "dismiss", body: 'You have been dismissed from the group "Dinner".', name: "telegram:-987" },
    { type: "audience", body: "Audience switched — the previous message was from the private DM.", name: "switch" },
    { type: "errors", body: "Recent Tomo errors before this turn (newest last, capped):\n- [error] boom" },
    { type: "direct-send", body: 'You sent the following message to this conversation earlier as a direct send: "hi"' },
    { type: "delegate", body: "From your other conversation, you were asked to: follow up with Alice." },
  ];

  for (const c of cases) {
    it(`round-trips a ${c.type} event`, () => {
      const formatted = formatTomoEvent(c.type, c.body, c.name !== undefined ? { name: c.name } : {});
      const parsed = parseTomoEvent(formatted);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe(c.type);
      expect(parsed!.body).toBe(c.body);
      expect(parsed!.name).toBe(c.name);
      expect(parsed!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });
  }

  it("returns null for legacy and plain text", () => {
    expect(parseTomoEvent("System: It is Fri. Free time.")).toBeNull();
    expect(parseTomoEvent("[System: audience switched]")).toBeNull();
    expect(parseTomoEvent("hey what's up")).toBeNull();
    expect(parseTomoEvent("<tomo-event type=\"cron\">unterminated")).toBeNull();
  });
});

describe("stripLeadingTomoEvents", () => {
  const note = formatTomoEvent("summon-expired", "Your summon expired.");
  const cron = formatTomoEvent("cron", "Scheduled task triggered.", { name: "job" });

  it("strips a single leading envelope", () => {
    expect(stripLeadingTomoEvents(`${note}\n\nhello`)).toBe("hello");
  });

  it("strips stacked envelopes", () => {
    expect(stripLeadingTomoEvents(`${note}\n\n${cron}\n\nhello`)).toBe("hello");
  });

  it("strips to empty for a pure harness turn", () => {
    expect(stripLeadingTomoEvents(cron)).toBe("");
  });

  it("does not touch envelopes that are not at the start", () => {
    const text = `hello\n\n${note}`;
    expect(stripLeadingTomoEvents(text)).toBe(text);
  });

  it("passes plain text through", () => {
    expect(stripLeadingTomoEvents("just a message")).toBe("just a message");
  });
});

describe("isHarnessEventText — tolerant dual-format reader", () => {
  it("recognizes the new envelope", () => {
    expect(isHarnessEventText(formatTomoEvent("heartbeat", "It is Fri."))).toBe(true);
  });

  it("recognizes both legacy conventions", () => {
    expect(isHarnessEventText("System: It is Fri, Jun 5. Weather ...")).toBe(true);
    expect(isHarnessEventText("[System: audience switched — ...]")).toBe(true);
  });

  it("ignores leading whitespace", () => {
    expect(isHarnessEventText("  \nSystem: hi")).toBe(true);
  });

  it("rejects real user messages, including ones that mention the markers", () => {
    expect(isHarnessEventText("hey what's up")).toBe(false);
    expect(isHarnessEventText("the System: prefix is legacy now")).toBe(false);
    expect(isHarnessEventText("[via satellite +1555] hello")).toBe(false);
  });
});
