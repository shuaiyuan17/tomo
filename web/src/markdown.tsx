import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { CodeBlock, codeBlockInfo } from "./code-block.js";
import { LINK_PROPS, safeHref } from "./links.js";

/**
 * remark-gfm's parsing half. remark-gfm also registers GFM serializers
 * (mdast-util-to-markdown and friends), which a render-only pipeline never
 * runs but would ship on the chat's critical path.
 */
function remarkGfm(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
}

// Module constants: the same plugin lists and renderers for every message.
const PLUGINS = [remarkGfm];
const PLUGINS_WITH_BREAKS = [remarkGfm, remarkBreaks];
const COMPONENTS: Components = {
  // Remote images would disclose local reading activity. Links require a
  // deliberate click and cannot take control of the local window.
  img: ({ alt }) => <span className="text-[13px] text-muted-foreground">[Image: {alt || "not loaded"}]</span>,
  a: ({ href, children }) => safeHref(href)
    ? <a href={href} {...LINK_PROPS}>{children}</a> : <span>{children}</span>,
  input: ({ checked }) => <input type="checkbox" checked={checked ?? false} disabled aria-label={checked ? "Completed task" : "Incomplete task"} />,
  pre: ({ node, children }) => <CodeBlock {...codeBlockInfo(node)}>{children}</CodeBlock>,
};

/**
 * Model output as markdown: no raw HTML, no remote images, safe links only.
 * `breaks`: a single newline is a line break (chat messages, so a list typed
 * one item per line in iMessage stays one per line); code blocks and real
 * markdown lists are unaffected. A fenced code block gets a copy button and,
 * when the fence names a language, a quiet label (no highlighting: see
 * code-block.tsx).
 *
 * Memoized on its two props (both primitives): the chat re-renders on every
 * keystroke and SSE event, and a message whose text did not change is not
 * parsed again.
 */
export const Text = memo(function Text({ children, breaks = false }: { children: string; breaks?: boolean }) {
  return <Markdown remarkPlugins={breaks ? PLUGINS_WITH_BREAKS : PLUGINS} skipHtml components={COMPONENTS}>{children}</Markdown>;
});
