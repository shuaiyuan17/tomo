/** Small display formatters shared by the watch TUI panes. */

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtUptime(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const ms = Math.max(0, now - ts);
  if (ms < 60_000) return "just now";
  return `${fmtUptime(ms)} ago`;
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function fmtEta(ts: number, now = Date.now()): string {
  const ms = ts - now;
  if (ms <= 0) return "now";
  if (ms < 60_000) return "<1m";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

/** `▓▓▓▓░░░░ 41%` context gauge. */
export function gauge(used: number, max: number, width = 10): string {
  if (max <= 0) return "─".repeat(width) + "  —";
  const frac = Math.min(1, used / max);
  const filled = Math.round(frac * width);
  return "▓".repeat(filled) + "░".repeat(width - filled) + ` ${Math.round(frac * 100)}%`;
}

/** Flatten whitespace and clip to one displayable line. */
export function oneLine(text: string, limit = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

export function elapsedSeconds(startedAt: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${secs % 60}s`;
}
