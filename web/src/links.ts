/**
 * The one rule for a link the page renders, shared by the markdown renderer
 * and the Sources row: http(s) only, opened in a new tab with
 * `rel="noopener noreferrer"` (LINK_PROPS), never fetched by the page itself.
 */
export function safeHref(href: string | undefined | null): href is string {
  return !!href && /^https?:\/\//.test(href);
}

export const LINK_PROPS = { target: "_blank", rel: "noopener noreferrer" } as const;

/** The host a source is shown with ("docs.astro.build"), without a leading www. */
export function sourceHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
