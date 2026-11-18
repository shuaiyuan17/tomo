/**
 * Credential names, references, and how the agent reads a stored value. Pure,
 * so anything can import it without pulling in the broker. The character set is
 * narrow because a name is interpolated into `security` commands and shown to
 * the owner in a prompt.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_PREFIX = "secret://";

/** The keychain service every broker item is stored under (the account is the name). */
export const KEYCHAIN_SERVICE = "tomo-credential-broker";

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

/**
 * The shell expression that yields a stored value, for use INSIDE a command
 * substitution in Bash: the value then reaches the command's argv or stdin but
 * never the command text, the transcript, or (unless printed) the output.
 */
export function keychainReadCommand(name: string): string {
  return `security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${name} -w`;
}

export const CREDENTIAL_TOOL_NAMES = ["request_credential"] as const;
