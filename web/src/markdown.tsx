import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock, codeBlockInfo } from "./code-block.js";
import { LINK_PROPS, safeHref } from "./links.js";

/**
 * Model output as markdown: no raw HTML, no remote images, safe links only.
 * `breaks`: a single newline is a line break (chat messages, so a list typed
 * one item per line in iMessage stays one per line); code blocks and real
 * markdown lists are unaffected. A fenced code block gets a copy button and,
 * when the fence names a language, a quiet label (no highlighting: see
 * code-block.tsx).
 */
export function Text({ children, breaks = false }: { children: string; breaks?: boolean }) {
  return <Markdown remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]} skipHtml components={{
    // Remote images would disclose local reading activity. Links require a
    // deliberate click and cannot take control of the local window.
    img: ({ alt }) => <span className="text-[13px] text-muted-foreground">[Image: {alt || "not loaded"}]</span>,
    a: ({ href, children }) => safeHref(href)
      ? <a href={href} {...LINK_PROPS}>{children}</a> : <span>{children}</span>,
    input: ({ checked }) => <input type="checkbox" checked={checked ?? false} disabled aria-label={checked ? "Completed task" : "Incomplete task"} />,
    pre: ({ node, children }) => <CodeBlock {...codeBlockInfo(node)}>{children}</CodeBlock>,
  }}>{children}</Markdown>;
}
