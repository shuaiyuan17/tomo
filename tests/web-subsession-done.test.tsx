import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubsessionView } from "../web/src/subsession-view.js";
import { i18n } from "../web/src/i18n/index.js";
import type { WebSubsession } from "../src/web/protocol.js";

// Whether the Done button is offered on an opened sub-session (the same as `/s <id> done <report>`).
// Pressing it, and what it clears, is covered end to end in tests/e2e/subsessions-panel.e2e.ts.
describe("sub-session Done", () => {
  const task = (over: Partial<WebSubsession> = {}): WebSubsession => ({ id: "s3", title: "Ship it", status: "finished", working: false,
    createdAt: 1, lastActivityAt: 1, activeMs: 0, revision: 1, writable: true, ...over });
  const render = (summary: WebSubsession, done?: (id: string, report: number) => Promise<WebSubsession>) =>
    renderToStaticMarkup(<SubsessionView summary={summary} revision={1} onBack={() => {}} {...(done ? { done } : {})} />);
  const done = async () => task();

  it("is offered on a task whose report asks the owner something, and only with a way to send it", async () => {
    await i18n.changeLanguage("en");
    const needsYou = task({ ownerAction: "Merge PR #3", reportSeq: 2 });
    expect(render(needsYou, done)).toContain(">Done</button>");
    expect(render(needsYou)).not.toContain(">Done</button>");
  });

  it("is not offered on any other task, nor without the report it would answer", () => {
    for (const shown of [task(), task({ status: "waiting", waitingOn: "owner" }), task({ status: "active" }), task({ ownerAction: "Merge PR #3" })])
      expect(render(shown, done)).not.toContain(">Done</button>");
  });
});
