import { useState } from "react";
import { Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadReceipt } from "./pending.js";

/** Read receipt text, for the tooltip and assistive tech. */
export function readReceiptLabel(receipt: ReadReceipt, agent: string): string {
  return receipt === "read" ? `Read by ${agent}` : receipt === "sent" ? "Sent" : "Queued";
}

/**
 * The tick in the bottom-right corner of one of the owner's own bubbles:
 * ✓ sent, ✓✓ read. "Queued" is left to the bubble's existing badge. Hidden
 * until the bubble is hovered or the tick has keyboard focus; hover shows the
 * label as a tooltip, and a tap (touch has no hover) shows it inline.
 */
export function ReadReceiptMark({ receipt, agent }: { receipt: ReadReceipt | undefined; agent: string }) {
  const [shown, setShown] = useState(false);
  if (!receipt || receipt === "queued") return null;
  const label = readReceiptLabel(receipt, agent);
  const Icon = receipt === "read" ? CheckCheck : Check;
  return <button type="button" className={cn("read-receipt absolute bottom-1.5 right-2.5 flex items-center gap-1 rounded px-1 text-[11px] text-muted-foreground",
    "opacity-0 transition-opacity group-hover:opacity-80 focus-visible:opacity-80 motion-reduce:transition-none",
    shown && "opacity-80")} data-receipt={receipt} title={label} aria-label={label}
    onClick={() => setShown((v) => !v)} onBlur={() => setShown(false)}>
    {shown && <span className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded-md border bg-popover px-1.5 py-0.5 text-popover-foreground shadow-sm">{label}</span>}<Icon className="size-3.5" strokeWidth={2} aria-hidden="true" /></button>;
}
