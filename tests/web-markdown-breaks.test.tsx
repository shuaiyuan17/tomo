import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Text } from "../web/src/markdown.js";

const render = (text: string, breaks = true) => renderToStaticMarkup(createElement(Text, { breaks }, text));

describe("chat message line breaks", () => {
  it("keeps single newlines (a list typed one item per line in iMessage)", () => {
    const html = render("• one\n• two\n• three");
    expect(html.match(/<br\/>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<p>• one • two/);
  });
  it("leaves code blocks and real markdown lists alone", () => {
    expect(render("```\na\nb\n```")).toContain("<pre><code>a\nb\n</code></pre>");
    const list = render("- one\n- two");
    expect(list).toContain("<ul>");
    expect(list).not.toContain("<br/>");
  });
  it("without breaks, markdown joins single newlines as before", () => {
    expect(render("a\nb", false)).not.toContain("<br/>");
  });
});
