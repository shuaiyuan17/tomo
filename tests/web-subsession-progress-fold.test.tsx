import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressFold } from "../web/src/subsession-view.js";

// What a sub-session is doing, folded into one line above its chat once something has been said.
describe("sub-session progress fold", () => {
  const summary = { text: "Run it in a loop", look: "running" as const, done: 1, total: 4 };

  it("closed, is one line: the step it is on, how far through, and a toggle that says it opens", () => {
    const html = renderToStaticMarkup(<ProgressFold summary={summary} open={false} onOpenChange={() => {}}><p data-testid="inside">checklist</p></ProgressFold>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="Show what it&#x27;s doing"');
    expect(html).toContain("Run it in a loop");
    expect(html).toContain("1/4");
    expect(html).toContain("1 of 4 steps done");
    expect(html).not.toContain("checklist");
  });

  it("open, shows what it folds", () => {
    const html = renderToStaticMarkup(<ProgressFold summary={summary} open onOpenChange={() => {}}><p>checklist</p></ProgressFold>);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('title="Hide what it&#x27;s doing"');
    expect(html).toContain("checklist");
  });

  it("without a plan, shows no count", () => {
    const html = renderToStaticMarkup(<ProgressFold summary={{ text: "Chose B", look: "update", done: 2 }} open={false} onOpenChange={() => {}}>x</ProgressFold>);
    expect(html).toContain("Chose B");
    expect(html).not.toMatch(/\d\/\d/);
  });
});
