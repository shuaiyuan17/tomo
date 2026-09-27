import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
export function Text({ children }: { children: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // Remote images would disclose local reading activity. Links require a
    // deliberate click and cannot take control of the local window.
    img: ({ alt }) => <span className="attachment">[Image: {alt || "not loaded"}]</span>,
    a: ({ href, children }) => href && /^https?:\/\//.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    input: ({ checked }) => <input type="checkbox" checked={checked ?? false} disabled aria-label={checked ? "Completed task" : "Incomplete task"} />,
  }}>{children}</Markdown>;
}
