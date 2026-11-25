import { memo, useEffect, useRef, useState } from "react";
import { Download, Eye, FileIcon, ImageIcon, X } from "lucide-react";
import { Text } from "./markdown.js";
import { isPreviewable, splitMessage, type SentFile } from "./attachments.js";
import { formatSize } from "./uploads.js";
import type { ReplyContext } from "./reply.js";
import { splitThinking } from "./thinking.js";
import { Thinking } from "./tool-calls.js";
import { cn } from "@/lib/utils";
import { i18n, useTranslation } from "./i18n/index.js";

/**
 * A chat message's body: the reply quote (if any), text with single line
 * breaks kept, images from messaging channels as thumbnails (never the raw
 * path), and other attachments as a named chip.
 *
 * `thinking` (Tomo's replies only): text marked as a thinking block shows as
 * a folded "Thinking" row, never as the reply. `block`: one live content
 * block; `joined`: a recorded turn (see splitThinking).
 *
 * Memoized: the chat re-renders on every keystroke and SSE event; an
 * unchanged body (streamed blocks, the pending bubbles) is skipped.
 */
export const MessageBody = memo(function MessageBody({ body, reply, sessionId, onQuote, thinking }:
  { body: string; reply?: ReplyContext; sessionId: string; onQuote?: () => void; thinking?: "block" | "joined" }) {
  // Memoized: subscribe, so a language switch re-renders the body.
  useTranslation();
  const [viewing, setViewing] = useState<string>();
  const segments = thinking ? splitThinking(body, thinking) : [{ kind: "reply" as const, text: body }];
  return <>
    {reply && <ReplyQuote reply={reply} onClick={onQuote} />}
    {segments.map((segment, at) => segment.kind === "thinking"
      ? <Thinking key={`t${at}`} text={segment.text} className="my-1" />
      : <ReplyParts key={`r${at}`} body={segment.text} sessionId={sessionId} onView={setViewing} />)}
    {viewing && <Lightbox src={viewing} onClose={() => setViewing(undefined)} />}
  </>;
});

function ReplyParts({ body, sessionId, onView }: { body: string; sessionId: string; onView: (src: string) => void }) {
  const setViewing = onView;
  return <>
    {splitMessage(body).map((part, index) => {
      if (part.kind === "text") return <Text key={index} breaks>{part.text}</Text>;
      if (part.kind === "sent") return <div key={index} className="my-1.5 flex flex-wrap gap-2">
        {part.ids.map((id, i) => id ? <Thumbnail key={`${id}:${i}`} src={sentUrl(sessionId, id)} sticker={false} onOpen={() => setViewing(sentUrl(sessionId, id))} />
          : <Placeholder key={`gone${i}`} label={i18n.t("chat:image.gone")} />)}
      </div>;
      if (part.kind === "sentFiles") return <div key={index} className="my-1.5 flex flex-wrap gap-2">
        {part.files.map((file, i) => <SentFileCard key={`${file.id}:${i}`} file={file} sessionId={sessionId} />)}</div>;
      if (part.kind === "images") return <div key={index} className="my-1.5 flex flex-wrap gap-2">
        {part.paths.map((path) => <Thumbnail key={path} src={mediaUrl(sessionId, path)} sticker={part.sticker} onOpen={() => setViewing(mediaUrl(sessionId, path))} />)}
        {Array.from({ length: part.missing }, (_, i) => <Placeholder key={`m${i}`} />)}
        {part.more > 0 && <span className="inline-flex h-16 items-center rounded-xl border bg-muted/50 px-3 text-[12px] text-muted-foreground">{i18n.t("chat:trace.more", { count: part.more })}</span>}
      </div>;
      if (part.files) return <div key={index} className="my-1.5 flex flex-wrap gap-2">
        {part.files.map((file, i) => <FileCard key={`${file.name}:${i}`} name={file.name} size={file.size} />)}</div>;
      return <span key={index} className="my-1 mr-1.5 inline-flex items-center gap-1.5 rounded-lg border bg-card/70 px-2 py-1 text-[12px] text-muted-foreground">
        <FileIcon className="size-3.5" aria-hidden="true" />{part.names.length ? part.names.join(", ") : part.label}</span>;
    })}
  </>;
}

/** A file sent in a message (not an image): icon, name, size — never the path. */
export function FileCard({ name, size }: { name: string; size?: string }) {
  return <span role="group" aria-label={size ? i18n.t("chat:file.labelSize", { name, size }) : i18n.t("chat:file.label", { name })} data-file-card=""
    className="inline-flex max-w-[280px] items-center gap-2.5 rounded-xl border bg-card/70 px-3 py-2">
    <FileIcon className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate font-sans text-[13px] text-foreground">{name}</span>
      {size && <span className="font-sans text-[11px] text-muted-foreground tabular-nums">{size}</span>}</span></span>;
}

/**
 * A file the agent sent: name, size, Download — and Preview for a small text
 * file. Both read it with fetch (same origin, the session's cookie, like any
 * API read), never by navigating to it: the bytes stay opaque to the page
 * until the owner asks, and a download is handed over as a blob.
 */
export function SentFileCard({ file, sessionId }: { file: SentFile; sessionId: string }) {
  const [preview, setPreview] = useState<{ text?: string; failed?: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const read = async () => {
    const response = await fetch(sentUrl(sessionId, file.id), { credentials: "same-origin", headers: { "x-tomo-request": "1" } });
    if (!response.ok) throw new Error(String(response.status));
    return response.blob();
  };
  const download = async () => {
    try {
      const url = URL.createObjectURL(await read());
      const link = document.createElement("a");
      link.href = url; link.download = file.name; link.rel = "noopener";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setFailed(false);
    } catch { setFailed(true); }
  };
  const open = async () => {
    setPreview({});
    try { setPreview({ text: await (await read()).text() }); } catch { setPreview({ failed: true }); }
  };
  const size = formatSize(file.size);
  return <span role="group" aria-label={i18n.t("chat:file.labelSize", { name: file.name, size })} data-sent-file=""
    className="inline-flex max-w-[320px] items-center gap-2.5 rounded-xl border bg-card/70 py-2 pr-1.5 pl-3">
    <FileIcon className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
    <span className="flex min-w-0 flex-1 flex-col leading-tight">
      <span className="truncate font-sans text-[13px] text-foreground">{file.name}</span>
      <span className={cn("font-sans text-[11px] tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>{failed ? i18n.t("chat:file.failed") : size}</span></span>
    {isPreviewable(file) && <button type="button" onClick={() => void open()} aria-label={i18n.t("chat:file.preview", { name: file.name })} title={i18n.t("chat:file.previewTitle")}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"><Eye className="size-4" strokeWidth={1.75} /></button>}
    <button type="button" onClick={() => void download()} aria-label={i18n.t("chat:file.download", { name: file.name })} title={i18n.t("chat:file.download", { name: file.name })}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"><Download className="size-4" strokeWidth={1.75} /></button>
    {preview && <TextPreview name={file.name} text={preview.text} failed={preview.failed} onClose={() => setPreview(null)} />}
  </span>;
}

/** A sent text file, read in place: plain text (never rendered as HTML or markdown), in an overlay like the Lightbox. */
function TextPreview({ name, text, failed, onClose }: { name: string; text?: string; failed?: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose]);
  return <div role="dialog" aria-modal="true" aria-label={i18n.t("chat:file.preview", { name })} onClick={onClose} data-file-preview=""
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in-0 sm:p-8">
    <div onClick={(e) => e.stopPropagation()} className="flex max-h-[88vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        <button ref={close} type="button" aria-label={i18n.t("chat:file.closePreview")} onClick={onClose}
          className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"><X className="size-4" /></button></div>
      <pre className="m-0 min-h-24 flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
        {failed ? i18n.t("chat:file.failed") : text ?? i18n.t("chat:file.loading")}</pre>
    </div>
  </div>;
}

const sentUrl = (sessionId: string, id: string) => `/api/v1/sessions/${sessionId}/outgoing/${id}`;
const mediaUrl = (sessionId: string, path: string) => `/api/v1/sessions/${sessionId}/media?path=${encodeURIComponent(path)}`;

function Thumbnail({ src, sticker, onOpen }: { src: string; sticker: boolean; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Placeholder />;
  return <button type="button" onClick={onOpen} aria-label={sticker ? i18n.t("chat:image.openSticker") : i18n.t("chat:image.open")}
    className="overflow-hidden rounded-xl border bg-muted/40 p-0 transition-opacity hover:opacity-90">
    <img src={src} alt={sticker ? i18n.t("chat:image.sticker") : i18n.t("chat:image.alt")} loading="lazy" onError={() => setFailed(true)}
      className={cn("block max-h-[280px] max-w-[280px] object-contain", sticker && "max-h-[140px] max-w-[140px]")} /></button>;
}

function Placeholder({ label }: { label?: string }) {
  return <span className={cn("inline-flex h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-muted/50 px-3 text-[11px] text-muted-foreground", !label && "w-24")}>
    <ImageIcon className="size-4" aria-hidden="true" />{label ?? i18n.t("chat:image.alt")}</span>;
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
  return <div role="dialog" aria-modal="true" aria-label={i18n.t("chat:image.alt")} onClick={onClose}
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 animate-in fade-in-0">
    <button ref={close} type="button" aria-label={i18n.t("chat:image.close")} onClick={onClose}
      className="absolute top-4 right-4 grid size-10 place-items-center rounded-xl bg-black/40 text-white hover:bg-black/60"><X className="size-5" /></button>
    <img src={src} alt={i18n.t("chat:image.alt")} onClick={(e) => e.stopPropagation()} className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
  </div>;
}

/** The message a reply quotes: one or two muted lines; clickable when the original is in view. */
export function ReplyQuote({ reply, onClick }: { reply: ReplyContext; onClick?: () => void }) {
  const label = reply.verb === "reacting" ? i18n.t("chat:reply.reacting") : i18n.t("chat:reply.replying");
  const content = <>
    <span className="block text-[10.5px] font-medium tracking-[0.02em] text-muted-foreground">{label}</span>
    <span className="line-clamp-2 text-[12.5px] leading-snug whitespace-pre-line text-muted-foreground">{reply.excerpt ?? i18n.t("chat:reaction.earlier")}</span>
  </>;
  const className = "mb-2 block w-full rounded-r-md border-l-2 border-muted-foreground/40 bg-foreground/[0.04] py-1 pr-2 pl-2.5 text-left";
  return onClick
    ? <button type="button" onClick={onClick} title={i18n.t("chat:reaction.showOriginal")} className={cn(className, "cursor-pointer transition-colors hover:bg-foreground/[0.07]")}>{content}</button>
    : <div className={className}>{content}</div>;
}
