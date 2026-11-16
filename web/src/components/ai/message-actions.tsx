/*!
 * Adapted from AI Elements `message.tsx` (https://github.com/vercel/ai-elements),
 * Copyright 2023 Vercel, Inc., licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0; full text in web/public/THIRD_PARTY_LICENSES.txt, shipped as dist/web-assets/THIRD_PARTY_LICENSES.txt).
 * Modified for tomo.
 * Changes: only MessageActions / MessageAction are kept, with a native
 * `title` instead of the Tooltip (one less overlay); the reaction picker and
 * the reaction pills are tomo's own (iMessage-style tapbacks); paper-palette
 * styling.
 */
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { CheckIcon, CopyIcon, Reply, SmilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { WebReaction } from "../../../../src/web/protocol.js";
import { REACTIONS, type ShownReaction } from "../../reactions.js";

/**
 * A message's actions: quiet until the message is hovered or holds focus (the
 * article carries `group/message`), always shown where there is no hover.
 * An open picker keeps them up.
 */
export function MessageActions({ className, children, ...props }: ComponentProps<"div">) {
  return <div role="toolbar" aria-orientation="horizontal" data-slot="message-actions"
    className={cn("flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 group-focus-within/message:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-70",
      className)} {...props}>{children}</div>;
}

export function MessageAction({ label, className, children, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <Button type="button" variant="ghost" size="icon" aria-label={label} title={label}
    className={cn("size-7 rounded-lg text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-[15px]", className)} {...props}>{children}</Button>;
}

export function ReplyAction({ onReply }: { onReply: () => void }) {
  return <MessageAction label="Reply" onClick={onReply}><Reply strokeWidth={1.75} /></MessageAction>;
}

export function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!text || !navigator.clipboard?.writeText) return null;
  return <>
    <MessageAction label={copied ? "Copied" : "Copy"} onClick={() => { navigator.clipboard.writeText(text).then(() => setCopied(true), () => {}); }}>
      {copied ? <CheckIcon strokeWidth={2} /> : <CopyIcon strokeWidth={1.75} />}</MessageAction>
    <span aria-live="polite" className="sr-only">{copied ? "Copied" : ""}</span>
  </>;
}

/** The six tapbacks in a pill; the owner's current one is marked (and choosing it again does nothing). */
export function ReactAction({ current, onReact }: { current?: WebReaction; onReact: (kind: WebReaction) => void }) {
  const [open, setOpen] = useState(false);
  // Non-modal: a modal Radix overlay injects a <style> tag the CSP refuses.
  return <Popover open={open} onOpenChange={setOpen} modal={false}>
    <PopoverTrigger asChild><MessageAction label="React"><SmilePlus strokeWidth={1.75} /></MessageAction></PopoverTrigger>
    <PopoverContent side="top" align="end" sideOffset={6} collisionPadding={12} aria-label="Reactions"
      className="flex w-auto items-center gap-0.5 rounded-full p-1 shadow-lg">
      {REACTIONS.map((reaction) => <button key={reaction.kind} type="button" aria-label={reaction.label} title={reaction.label}
        aria-pressed={current === reaction.kind}
        onClick={() => { setOpen(false); if (current !== reaction.kind) onReact(reaction.kind); }}
        className={cn("grid size-9 place-items-center rounded-full text-[19px] leading-none transition-[background-color,transform] duration-150 hover:scale-[1.18] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-95",
          current === reaction.kind && "bg-primary/15 hover:bg-primary/20")}>
        <span aria-hidden="true">{reaction.emoji}</span></button>)}
    </PopoverContent>
  </Popover>;
}

const WHO: Record<ShownReaction["from"], string> = { you: "You", agent: "", participant: "Someone" };

/** Tapbacks on a message, as small pills tucked under its corner. */
export function ReactionPills({ reactions, agent, className }: { reactions: readonly ShownReaction[]; agent: string; className?: string }) {
  if (!reactions.length) return null;
  return <div data-slot="reactions" className={cn("flex flex-wrap gap-1", className)}>
    {reactions.map((shown, index) => {
      const who = shown.from === "agent" ? agent : WHO[shown.from];
      const label = `${who} ${shown.reaction.verb} this${shown.pending ? " (sending)" : ""}`;
      return <span key={`${shown.from}:${index}`} role="img" aria-label={label} title={label}
        className={cn("motion-enter inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-full border bg-card px-1.5 text-[13px] leading-none shadow-xs",
          shown.from === "agent" && "border-primary/30 bg-primary/10", shown.pending && "opacity-60")}>
        <span aria-hidden="true">{shown.reaction.emoji}</span>
        {shown.from === "agent" && <span aria-hidden="true" className="font-sans text-[10px] font-medium text-muted-foreground">{agent}</span>}
      </span>;
    })}
  </div>;
}

/** A tapback record in the conversation: one quiet line, not a bubble. */
export function TapbackLine({ who, reaction, quote, meta, onQuote }:
  { who: string; reaction: ShownReaction["reaction"]; quote?: string | null; meta?: ReactNode; onQuote?: () => void }) {
  const quoted = quote ? `“${quote}”` : "an earlier message";
  const text = <><span aria-hidden="true" className="mr-1.5 text-[14px]">{reaction.emoji}</span>
    <span className="font-medium text-foreground/80">{who}</span> {reaction.verb} {quoted}</>;
  return <div className="flex min-w-0 items-baseline gap-3 text-[12px] text-muted-foreground">
    {onQuote
      ? <button type="button" onClick={onQuote} title="Show the original message" className="min-w-0 truncate rounded-md text-left transition-colors hover:text-foreground">{text}</button>
      : <span className="min-w-0 truncate">{text}</span>}
    {meta}
  </div>;
}
