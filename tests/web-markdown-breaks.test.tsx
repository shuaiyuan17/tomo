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
    expect(render("```\na\nb\n```")).toContain("<code>a\nb\n</code></pre>");
    const list = render("- one\n- two");
    expect(list).toContain("<ul>");
    expect(list).not.toContain("<br/>");
  });
  it("without breaks, markdown joins single newlines as before", () => {
    expect(render("a\nb", false)).not.toContain("<br/>");
  });
  it("parses GFM (tables, strikethrough, task lists, autolinks, footnotes) with and without breaks", () => {
    for (const breaks of [true, false]) {
      const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ www.example.com\n\n- [x] done\n- [ ] todo\n\nNote[^1]\n\n[^1]: The footnote.", breaks);
      expect(html).toContain("<table>");
      expect(html).toContain("<td>2</td>");
      expect(html).toContain("<del>gone</del>");
      expect(html).toContain('<a href="http://www.example.com" target="_blank" rel="noopener noreferrer">www.example.com</a>');
      expect(html).toContain('aria-label="Completed task"');
      expect(html).toContain('aria-label="Incomplete task"');
      expect(html).toContain("The footnote.");
      expect(html).toContain("<sup><span>1</span></sup>");
    }
  });
});
