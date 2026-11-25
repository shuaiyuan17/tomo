import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebContext, WebSession } from "../src/web/protocol.js";

/**
 * The Context tab as the Study routes to it (`#study/context`): the pure and
 * view tests in web-context-view.test.ts would still pass if study.tsx went
 * back to drawing its own page, so this renders the Study itself.
 */
const requested: Array<string | null> = [];
const reading: WebContext = { used: 128_400, max: 200_000, estimated: false, recordedAt: null,
  breakdown: [{ name: "System prompt", tokens: 31_400 }, { name: "Messages", tokens: 97_000 }, { name: "MCP tools (deferred)", tokens: 59_000 },
    { name: "Compact buffer", tokens: 3_000 }, { name: "Free space", tokens: 68_600 }],
  analysisStatus: "unavailable", analysis: null, summariesTruncated: false,
  summaries: [{ tag: "daily 2026-11-12", level: "daily", timestamp: "2026-11-13T09:00:00.000Z", eventsSummarized: 184, content: "Did things.", truncated: false }] };

vi.mock("../web/src/study-data.js", async (original) => ({
  ...await original<typeof import("../web/src/study-data.js")>(),
  // No effects run in a static render: answer the page's one read at once.
  useResource: (path: string | null) => { requested.push(path); return [{ state: "ready", value: reading }, () => undefined]; },
}));

const { Study } = await import("../web/src/study.js");
const session = { id: "s".repeat(43), title: "Owner conversation" } as unknown as WebSession;
const study = (props: { session?: WebSession }) => renderToStaticMarkup(createElement(Study, { page: "context", onPage: () => undefined, reload: 0,
  mutator: { refresh: async () => { throw new Error("unused"); }, live: true }, ...props }));

describe("the Study's Context tab", () => {
  // What the page draws (share, tone, segments, the rows) is web-context-view.test.ts's;
  // here only that the Study reads this conversation and draws that page.
  it("reads the selected conversation's context and draws the window meter, not a flat list of SDK rows", () => {
    requested.length = 0;
    const html = study({ session });
    expect(requested).toEqual([`/sessions/${session.id}/context`]);
    expect(html).toContain("Context window · Owner conversation");
    expect(html).toMatch(/role="meter"/);
    // The old page listed these as if they filled the window.
    expect(html).not.toContain("Free space");
    expect(html).toContain("Rolled-up history");
  });

  it("asks for a conversation when none is selected", () => {
    expect(study({})).toContain("Choose a conversation in the sidebar.");
  });
});
