import { FileIcon, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { attachmentLabel, formatSize, type Attachment } from "./uploads.js";
import { i18n } from "./i18n/index.js";

/** The composer's tray: each attachment with its upload progress, a retry when it failed, and a remove button. */
export function AttachmentTray({ items, filesOn, onRetry, onRemove }: { items: readonly Attachment[]; filesOn: boolean; onRetry: (key: string) => void; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return <ul aria-label={filesOn ? i18n.t("chat:attach.list") : i18n.t("chat:attach.images")} className="m-0 mb-2 flex list-none flex-wrap gap-2 p-0">
    {items.map((item, index) => {
      const failed = item.status === "failed";
      const retryLabel = item.error ? i18n.t("chat:attach.retryWith", { error: item.error }) : i18n.t("chat:attach.retry");
      const remove = <button type="button" onClick={() => onRemove(item.key)} aria-label={i18n.t("chat:attach.remove", { name: item.file.name || (item.kind === "file" ? i18n.t("chat:attach.fileN", { n: index + 1 }) : i18n.t("chat:attach.imageN", { n: index + 1 })) })}
        className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-foreground/70 text-background transition-colors hover:bg-foreground focus-visible:outline-offset-0"><X className="size-3" strokeWidth={2.5} /></button>;
      if (item.kind === "file") return <li key={item.key} aria-label={attachmentLabel(item, index)} data-kind="file"
        className={cn("relative flex h-16 max-w-[260px] items-center gap-2.5 overflow-hidden rounded-xl border bg-muted/40 py-2 pr-9 pl-3 motion-enter", failed && "border-destructive/60")}>
        <FileIcon className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <span className={cn("flex min-w-0 flex-col", item.status !== "done" && "opacity-60")}>
          <span className="truncate text-[13px] text-foreground">{item.file.name || i18n.t("chat:attach.fileN", { n: index + 1 })}</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{failed ? item.error ?? i18n.t("chat:attach.failed") : formatSize(item.file.size)}</span></span>
        {item.status === "uploading" && <UploadProgress progress={item.progress} className="inset-x-3" />}
        {failed && <button type="button" onClick={() => onRetry(item.key)} title={item.error} aria-label={retryLabel}
          className="absolute top-1 right-8 grid size-6 place-items-center rounded-full text-destructive hover:bg-background/60"><RotateCw className="size-3.5" /></button>}
        {remove}
      </li>;
      return <li key={item.key} aria-label={attachmentLabel(item, index)}
        className={cn("relative size-16 overflow-hidden rounded-xl border bg-muted/40 motion-enter", failed && "border-destructive/60")}>
        <img src={item.preview} alt="" className={cn("size-full object-cover", item.status !== "done" && "opacity-60")} />
        {item.status === "uploading" && <UploadProgress progress={item.progress} className="inset-x-1.5" />}
        {failed && <button type="button" onClick={() => onRetry(item.key)} title={item.error} aria-label={retryLabel}
          className="absolute inset-0 grid place-items-center bg-background/60 text-destructive hover:bg-background/40"><RotateCw className="size-4" /></button>}
        {remove}
      </li>;
    })}</ul>;
}

function UploadProgress({ progress, className }: { progress: number; className: string }) {
  const percent = Math.round(progress * 100);
  return <span className={cn("absolute bottom-1.5 h-1 overflow-hidden rounded-full bg-background/70", className)} role="progressbar" aria-label={i18n.t("chat:attach.progress")}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span className="block h-full bg-primary transition-[width] duration-150" style={{ width: `${percent}%` }} /></span>;
}
