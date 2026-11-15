import { useEffect, useRef, useState } from "react";
import { FileIcon, ImageIcon, X } from "lucide-react";
import { Text } from "./markdown.js";
import { splitMessage } from "./attachments.js";
import type { ReplyContext } from "./reply.js";
import { splitThinking } from "./thinking.js";
import { Thinking } from "./tool-calls.js";
import { cn } from "@/lib/utils";

/**
 * A chat message's body: the reply quote (if any), text with single line
 * breaks kept, images from messaging channels as thumbnails (never the raw
 * path), and other attachments as a named chip.
 *
 * `thinking` (Tomo's replies only): text marked as a thinking block shows as
 * a folded "Thinking" row, never as the reply. `block`: one live content
 * block; `joined`: a recorded turn (see splitThinking).
 */
export function MessageBody({ body, reply, sessionId, onQuote, thinking }:
  { body: string; reply?: ReplyContext; sessionId: string; onQuote?: () => void; thinking?: "block" | "joined" }) {
  const [viewing, setViewing] = useState<string>();
  const segments = thinking ? splitThinking(body, thinking) : [{ kind: "reply" as const, text: body }];
  return <>
    {reply && <ReplyQuote reply={reply} onClick={onQuote} />}
    {segments.map((segment, at) => segment.kind === "thinking"
      ? <Thinking key={`t${at}`} text={segment.text} className="my-1" />
      : <ReplyParts key={`r${at}`} body={segment.text} sessionId={sessionId} onView={setViewing} />)}
    {viewing && <Lightbox src={viewing} onClose={() => setViewing(undefined)} />}
  </>;
}

function ReplyParts({ body, sessionId, onView }: { body: string; sessionId: string; onView: (src: string) => void }) {
  const setViewing = onView;
  return <>
    {splitMessage(body).map((part, index) => {
      if (part.kind === "text") return <Text key={index} breaks>{part.text}</Text>;
      if (part.kind === "sent") return <div key={index} className="my-1.5 flex flex-wrap gap-2">
        {part.ids.map((id, i) => id ? <Thumbnail key={`${id}:${i}`} src={sentUrl(sessionId, id)} sticker={false} onOpen={() => setViewing(sentUrl(sessionId, id))} />
          : <Placeholder key={`gone${i}`} label="Image (no longer available)" />)}
      </div>;
      if (part.kind === "images") return <div key={index} className="my-1.5 flex flex-wrap gap-2">
        {part.paths.map((path) => <Thumbnail key={path} src={mediaUrl(sessionId, path)} sticker={part.sticker} onOpen={() => setViewing(mediaUrl(sessionId, path))} />)}
        {Array.from({ length: part.missing }, (_, i) => <Placeholder key={`m${i}`} />)}
        {part.more > 0 && <span className="inline-flex h-16 items-center rounded-xl border bg-muted/50 px-3 text-[12px] text-muted-foreground">+{part.more} more</span>}
      </div>;
      return <span key={index} className="my-1 mr-1.5 inline-flex items-center gap-1.5 rounded-lg border bg-card/70 px-2 py-1 text-[12px] text-muted-foreground">
        <FileIcon className="size-3.5" aria-hidden="true" />{part.names.length ? part.names.join(", ") : part.label}</span>;
    })}
  </>;
}

const sentUrl = (sessionId: string, id: string) => `/api/v1/sessions/${sessionId}/outgoing/${id}`;
const mediaUrl = (sessionId: string, path: string) => `/api/v1/sessions/${sessionId}/media?path=${encodeURIComponent(path)}`;

function Thumbnail({ src, sticker, onOpen }: { src: string; sticker: boolean; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Placeholder />;
  return <button type="button" onClick={onOpen} aria-label={sticker ? "Open sticker" : "Open image"}
    className="overflow-hidden rounded-xl border bg-muted/40 p-0 transition-opacity hover:opacity-90">
    <img src={src} alt={sticker ? "Sticker" : "Image"} loading="lazy" onError={() => setFailed(true)}
      className={cn("block max-h-[280px] max-w-[280px] object-contain", sticker && "max-h-[140px] max-w-[140px]")} /></button>;
}

function Placeholder({ label = "Image" }: { label?: string }) {
  return <span className={cn("inline-flex h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-muted/50 px-3 text-[11px] text-muted-foreground", label === "Image" && "w-24")}>
    <ImageIcon className="size-4" aria-hidden="true" />{label}</span>;
}

/**
 * Full-size view. A hand-rolled overlay, not shadcn's Dialog: a modal Radix
 * dialog injects an inline <style> (scroll lock) that the CSP refuses.
 */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose]);
  return <div role="dialog" aria-modal="true" aria-label="Image" onClick={onClose}
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 animate-in fade-in-0">
    <button ref={close} type="button" aria-label="Close image" onClick={onClose}
      className="absolute top-4 right-4 grid size-10 place-items-center rounded-xl bg-black/40 text-white hover:bg-black/60"><X className="size-5" /></button>
    <img src={src} alt="Image" onClick={(e) => e.stopPropagation()} className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
  </div>;
}

/** The message a reply quotes: one or two muted lines; clickable when the original is in view. */
function ReplyQuote({ reply, onClick }: { reply: ReplyContext; onClick?: () => void }) {
  const label = reply.verb === "reacting" ? "Reacting to" : "Replying to";
  const content = <>
    <span className="block text-[10.5px] font-medium tracking-[0.02em] text-muted-foreground">{label}</span>
    <span className="line-clamp-2 text-[12.5px] leading-snug whitespace-pre-line text-muted-foreground">{reply.excerpt ?? "an earlier message"}</span>
  </>;
  const className = "mb-2 block w-full rounded-r-md border-l-2 border-muted-foreground/40 bg-foreground/[0.04] py-1 pr-2 pl-2.5 text-left";
  return onClick
    ? <button type="button" onClick={onClick} title="Show the original message" className={cn(className, "cursor-pointer transition-colors hover:bg-foreground/[0.07]")}>{content}</button>
    : <div className={className}>{content}</div>;
}
