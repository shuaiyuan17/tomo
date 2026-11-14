/**
 * Credential names and references. Pure, so the permission guard can import it
 * without pulling in the broker. The character set is narrow because a name is
 * interpolated into `security -i` commands and shown to the owner in a prompt.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_PREFIX = "secret://";

export function isCredentialName(name: string): boolean {
  return NAME_RE.test(name);
}

export function secretRefFor(name: string): string {
  return `${REF_PREFIX}${name}`;
}

/** The name a ref points at, or null when it is not a well-formed ref. */
export function parseSecretRef(ref: string): string | null {
  if (!ref.startsWith(REF_PREFIX)) return null;
  const name = ref.slice(REF_PREFIX.length);
  return isCredentialName(name) ? name : null;
}

export const CREDENTIAL_TOOL_NAMES = ["request_credential", "run_with_secrets"] as const;

/** `run_with_secrets` is a shell, and an `agentProfiles` entry's Bash rules only
 *  look at the Bash tool, so a profiled subagent must not reach it. */
export const RUN_WITH_SECRETS_TOOL = "mcp__tomo-internal__run_with_secrets";
