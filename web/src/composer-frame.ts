/**
 * The input bar's frame, shared by the DM composer and a sub-session's
 * composer in the Tasks rail: with the rail open beside the DM, both bars
 * are the same height and (both columns ending 1.5rem above the bottom)
 * share a bottom edge. Change these together, never one bar alone.
 */
export const COMPOSER_FORM = "flex items-end gap-1 rounded-[20px] border bg-card p-2.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-muted-foreground/50 focus-within:shadow-md";
/** The field: one line is as tall as the buttons beside it (size-10 with its padding). */
export const COMPOSER_FIELD = "min-h-10 flex-1 resize-none rounded-none border-0 bg-transparent! py-[7px] pl-1.5 leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:ring-0";
export const COMPOSER_SEND = "size-9 shrink-0 rounded-full transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.94] disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100";
