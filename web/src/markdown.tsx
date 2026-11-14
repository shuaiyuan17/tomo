import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Model output as markdown: no raw HTML, no remote images, safe links only.
 * `breaks`: a single newline is a line break (chat messages, so a list typed
 * one item per line in iMessage stays one per line); code blocks and real
 * markdown lists are unaffected.
 */
export function Text({ children, breaks = false }: { children: string; breaks?: boolean }) {
  return <Markdown remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]} skipHtml components={{
    // Remote images would disclose local reading activity. Links require a
    // deliberate click and cannot take control of the local window.
    img: ({ alt }) => <span className="text-[13px] text-muted-foreground">[Image: {alt || "not loaded"}]</span>,
    a: ({ href, children }) => href && /^https?:\/\//.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    input: ({ checked }) => <input type="checkbox" checked={checked ?? false} disabled aria-label={checked ? "Completed task" : "Incomplete task"} />,
  }}>{children}</Markdown>;
}
