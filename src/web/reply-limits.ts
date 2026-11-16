/**
 * Limits of a web reply or reaction the browser shares with the daemon.
 * Kept out of protocol.ts on purpose: importing a VALUE from there pulls zod
 * into the page bundle, and zod's JIT probe (`Function("")`) is an eval the
 * page's CSP (script-src 'self') refuses.
 */

/** Longest quoted text a web reply or reaction carries, in UTF-16 units (the agent sees a 60-code-point excerpt of it, as on iMessage). */
export const WEB_REPLY_TEXT_LIMIT = 2_000;
