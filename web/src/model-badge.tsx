import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { modelLabel } from "./tasks.js";

/** A small, quiet badge naming a subagent's model; nothing when unknown. */
export function ModelBadge({ model, className }: { model?: string; className?: string }) {
  if (!model) return null;
  return <Badge variant="outline" title={model}
    className={cn("ml-1 h-4 rounded-[5px] border-border/80 px-1 align-[1px] text-[9.5px] leading-none font-normal text-muted-foreground", className)}>{modelLabel(model)}</Badge>;
}
