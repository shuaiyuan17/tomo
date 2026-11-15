import { useState } from "react";
import { Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadReceipt } from "./pending.js";

/** Read receipt text, for the tooltip and assistive tech. */
export function readReceiptLabel(receipt: ReadReceipt, agent: string): string {
  return receipt === "read" ? `Read by ${agent}` : receipt === "sent" ? "Sent" : "Queued";
}

/**
 * The tick under one of the owner's own messages: ✓ sent, ✓✓ read. "Queued"
 * is left to the bubble's existing badge. Hover shows the label; a tap (touch
 * has no hover) shows it inline.
 */
export function ReadReceiptMark({ receipt, agent }: { receipt: ReadReceipt | undefined; agent: string }) {
  const [shown, setShown] = useState(false);
  if (!receipt || receipt === "queued") return null;
  const label = readReceiptLabel(receipt, agent);
  const Icon = receipt === "read" ? CheckCheck : Check;
  return <button type="button" className={cn("read-receipt mt-1 flex items-center gap-1 self-end rounded px-1 text-[11px] text-muted-foreground",
    receipt === "read" ? "opacity-90" : "opacity-60")} data-receipt={receipt} title={label} aria-label={label}
    onClick={() => setShown((v) => !v)} onBlur={() => setShown(false)}>
    <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />{shown && <span>{label}</span>}</button>;
}
