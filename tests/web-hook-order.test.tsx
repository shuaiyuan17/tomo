// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextView } from "../web/src/context-page.js";
import { QuotaBar } from "../web/src/cost-page.js";
import type { WebContext, WebCostLimits } from "../src/web/protocol.js";

// A component that calls a hook only after an early return renders fine the first time it mounts.
// Once the same mounted instance re-renders with a different number of hooks (its data went from
// empty to non-empty), React reports it on console.error ("Expected static flag was missing", and
// in other shapes "Rendered more hooks than during the previous render"). Server rendering cannot
// see that: it takes a live root and re-renders, so each case goes empty -> some -> empty and
// fails on any error React logs on the way.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); errors = vi.spyOn(console, "error"); });
afterEach(() => { act(() => root.unmount()); host.remove(); errors.mockRestore(); });
const render = (element: Parameters<Root["render"]>[0]) => act(() => root.render(element));

const context = (over: Partial<WebContext> = {}): WebContext => ({ used: 1_000, max: 200_000, estimated: false, recordedAt: null, breakdown: [],
  analysisStatus: "unavailable", analysis: null, summaries: [], summariesTruncated: false, ...over });
const limits = (windows: WebCostLimits["windows"]): WebCostLimits => ({ sampledAt: "2026-11-15T12:00:00Z", source: "test", windows });

describe("components that render nothing for empty data keep their hook order", () => {
  it("the context page's compactions go from none to some and back", () => {
    const some = context({ recentCompactions: [{ timestamp: Date.parse("2026-11-15T10:00:00Z"), preTokens: 180_000, postTokens: 40_000 }] });
    render(createElement(ContextView, { value: context(), title: "Conversation" }));
    expect(host.textContent).not.toMatch(/180/);
    render(createElement(ContextView, { value: some, title: "Conversation" }));
    expect(host.textContent).toMatch(/180/);
    render(createElement(ContextView, { value: context(), title: "Conversation" }));
    expect(host.textContent).not.toMatch(/180/);
    expect(errors).not.toHaveBeenCalled();
  });

  it("the cost page's quota bar goes from no window to one and back", () => {
    render(createElement(QuotaBar, { limits: limits([]) }));
    expect(host.textContent).toBe("");
    render(createElement(QuotaBar, { limits: limits([{ window: "five_hour", percent: 34 }]) }));
    expect(host.textContent).toMatch(/5-hour/);
    render(createElement(QuotaBar, { limits: limits([]) }));
    expect(host.textContent).toBe("");
    expect(errors).not.toHaveBeenCalled();
  });
});
