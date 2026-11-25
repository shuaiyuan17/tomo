import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Study } from "../web/src/study.js";

// The Study tab strip scrolls sideways on a phone. With only overflow-x set,
// browsers compute overflow-y as auto too, so the strip also scrolled up and
// down a few pixels under a finger. It must only move horizontally.
describe("Study tab strip", () => {
  it("scrolls horizontally only", () => {
    const html = renderToStaticMarkup(<Study page="todos" onPage={() => {}} reload={0} mutator={{ refresh: async () => { throw new Error("unused"); }, live: true }} />);
    const strip = /<div[^>]*role="tablist"[^>]*>/.exec(html)?.[0] ?? "";
    expect(strip).toContain('aria-label="Study sections"');
    const classes = /class="([^"]*)"/.exec(strip)?.[1].split(/\s+/) ?? [];
    for (const name of ["overflow-x-auto", "overflow-y-hidden", "touch-pan-x"]) expect(classes).toContain(name);
  });
});
