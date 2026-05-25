/**
 * Pure helpers for `send_message` target resolution. No I/O, no config, no
 * channel imports — safe to import from tests without triggering the rest of
 * the agent's startup graph.
 */

/**
 * Canonicalize a `send_message` target to its session key form.
 *
 * - **Identity name** (no colon): case-insensitive lookup against the
 *   identities config. Returns `dm:<lowercased name>` so the result matches
 *   the inbound DM key built in `router.ts` (which lowercases there too).
 *   Returns `null` if no identity matches.
 * - **`dm:<name>` key**: lowercases the name part. Caller passing
 *   `dm:Shuai` lands on the same `dm:shuai` session as the inbound path,
 *   preventing a duplicate-cased shadow session from being created.
 * - **`<channel>:<chatId>` key**: returned unchanged.
 */
export function normalizeSendTarget(
  target: string,
  identities: ReadonlyArray<{ name: string }>,
): { sessionKey: string; identityName?: string } | null {
  if (!target.includes(":")) {
    const identity = identities.find(
      (i) => i.name.toLowerCase() === target.toLowerCase(),
    );
    if (!identity) return null;
    return {
      sessionKey: `dm:${identity.name.toLowerCase()}`,
      identityName: identity.name,
    };
  }
  if (target.startsWith("dm:")) {
    return { sessionKey: `dm:${target.slice(3).toLowerCase()}` };
  }
  return { sessionKey: target };
}
