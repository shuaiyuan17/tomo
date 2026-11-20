import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "./i18n/index.js";

/**
 * A fenced code block in rendered markdown: the code as react-markdown
 * renders it, a copy button (top right; shown on hover or focus, always on
 * touch screens) and, when the fence names a language, a quiet label.
 * Markup after shadcn's Code Block (header, title, actions, copy button).
 *
 * No syntax highlighting: the highlighters at hand (Shiki, Prism via
 * react-syntax-highlighter, …) colour tokens with inline `style` attributes
 * or an injected <style>, both refused by the page's CSP (`style-src
 * 'self'`).
 */
export function CodeBlock({ language, code, children }: { language?: string; code: string; children: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  return <div data-slot="code-block" className="group/code relative my-4 max-w-full rounded-xl border bg-card font-sans">
    {language && <div data-slot="code-block-header" className="flex h-7 items-center px-4 pt-1.5 text-[11px] leading-none tracking-[0.02em] text-muted-foreground">
      <span data-slot="code-block-title" className="min-w-0 truncate">{language}</span></div>}
    <div data-slot="code-block-actions" className={cn("absolute right-1.5 z-10 opacity-0 transition-opacity group-hover/code:opacity-100 group-focus-within/code:opacity-100 pointer-coarse:opacity-100",
      language ? "top-1" : "top-1.5")}>
      <CopyButton value={code} fallback={pre} />
    </div>
    <pre ref={pre} className={cn("m-0! bg-transparent!", language ? "pt-2!" : "pr-10!")}>{children}</pre>
  </div>;
}

function CopyButton({ value, fallback }: { value: string; fallback: RefObject<HTMLPreElement | null> }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const { t } = useTranslation("chat");
  const copy = () => {
    // Without the async clipboard (a page that is not a secure context), select the code so the reader can copy it.
    const select = () => { const node = fallback.current; const range = document.createRange(); if (!node) return;
      range.selectNodeContents(node); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); };
    if (!navigator.clipboard?.writeText) { select(); return; }
    navigator.clipboard.writeText(value).then(() => setCopied(true), select);
  };
  return <>
    <button type="button" data-slot="code-block-copy-button" aria-label={copied ? t("actions.copied") : t("actions.copyCode")} title={copied ? t("actions.copied") : t("actions.copy")} onClick={copy}
      className="grid size-6 place-items-center rounded-md bg-background/80 text-muted-foreground ring-1 ring-foreground/10 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
    </button>
    <span aria-live="polite" className="sr-only">{copied ? t("actions.copied") : ""}</span>
  </>;
}

/** The parts of a hast <pre> node CodeBlock needs. */
interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/**
 * The code a <pre> holds (its text, exactly, for the copy button) and the
 * fence's language (react-markdown's `language-xxx` class on the <code>), as
 * a label: letters, digits and `+#._-`, at most 24 characters.
 */
export function codeBlockInfo(node: unknown): { code: string; language?: string } {
  const pre = node as HastNode | undefined;
  const code = pre?.children?.find((child) => child.type === "element" && child.tagName === "code");
  const text = (n: HastNode | undefined): string => !n ? "" : n.type === "text" ? n.value ?? "" : (n.children ?? []).map(text).join("");
  const classes = code?.properties?.className;
  const fence = (Array.isArray(classes) ? classes : []).map(String).find((name) => name.startsWith("language-"))?.slice("language-".length);
  const language = fence && /^[A-Za-z0-9_+#.-]{1,24}$/.test(fence) ? fence : undefined;
  return { code: text(code ?? pre).replace(/\n$/, ""), ...(language ? { language } : {}) };
}
