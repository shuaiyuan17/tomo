import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chat, ProgressFold } from "../web/src/subsession-view.js";
import { AgentNameContext } from "../web/src/agent-name.js";
import { i18n } from "../web/src/i18n/index.js";
import type { SubsessionChatRow } from "../web/src/subsessions.js";

// What a sub-session is doing, folded into one line under the brief, above its chat, once something has been said.
describe("sub-session progress fold", () => {
  const summary = { text: "Run it in a loop", look: "running" as const, done: 1, total: 4 };

  it("closed, is one line: the step it is on, how far through, and a toggle that says it opens", () => {
    const html = renderToStaticMarkup(<ProgressFold summary={summary} open={false} onOpenChange={() => {}}><p data-testid="inside">checklist</p></ProgressFold>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="Show what Tomo&#x27;s doing"');
    expect(html).toContain("Run it in a loop");
    expect(html).toContain("1/4");
    expect(html).toContain("1 of 4 steps done");
    expect(html).not.toContain("checklist");
  });

  it("open, shows what it folds", () => {
    const html = renderToStaticMarkup(<ProgressFold summary={summary} open onOpenChange={() => {}}><p>checklist</p></ProgressFold>);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('title="Hide what Tomo&#x27;s doing"');
    expect(html).toContain("checklist");
  });

  it("without a plan, shows no count", () => {
    const html = renderToStaticMarkup(<ProgressFold summary={{ text: "Chose B", look: "update", done: 2 }} open={false} onOpenChange={() => {}}>x</ProgressFold>);
    expect(html).toContain("Chose B");
    expect(html).not.toMatch(/\d\/\d/);
  });

  it("names the agent by its own name", () => {
    const html = renderToStaticMarkup(<AgentNameContext.Provider value="Mochi"><ProgressFold summary={summary} open onOpenChange={() => {}}>x</ProgressFold></AgentNameContext.Provider>);
    expect(html).toContain('title="Hide what Mochi&#x27;s doing"');
    expect(i18n.t("tasks:subsession.doing.heading", { agent: "Tomo" })).toBe("What Tomo's doing");
    expect(i18n.t("tasks:subsession.doing.heading", { agent: "Tomo", lng: "zh-Hans" })).toBe("Tomo 在做什么");
  });
});

describe("sub-session chat", () => {
  const brief: SubsessionChatRow = { kind: "brief", key: "b", brief: "Find why it flakes.", truncated: false };
  const reply: SubsessionChatRow = { kind: "entry", key: "e1", from: "task", text: "It races the first paint.", at: 1 };
  const chat = (rows: SubsessionChatRow[], fold?: boolean) => renderToStaticMarkup(<Chat rows={rows} status="ready" id="s1" onRetry={() => {}} follow={rows.length > 1}
    fold={fold ? <div data-testid="subsession-progress">fold</div> : undefined} />);

  it("with only the brief, says nothing more: no line asking the owner to write", () => {
    const html = chat([brief]);
    expect(html).toContain("Find why it flakes.");
    expect(html).not.toMatch(/Nothing said yet|Write to s1 below/);
    expect(html.match(/<li/g)).toHaveLength(1);
    expect(i18n.exists("tasks:subsession.nothingYet")).toBe(false);
  });

  it("puts the folded line after the brief and before the conversation", () => {
    const html = chat([brief, reply], true);
    const at = (needle: string) => { const i = html.indexOf(needle); expect(i).toBeGreaterThanOrEqual(0); return i; };
    expect(at("Find why it flakes.")).toBeLessThan(at('data-testid="subsession-progress"'));
    expect(at('data-testid="subsession-progress"')).toBeLessThan(at("It races the first paint."));
  });
});
