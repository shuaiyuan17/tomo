import { execFile, type ExecFileException } from "node:child_process";
import type { OwnerT, OwnerText } from "../i18n/index.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Fallback credentials file used on Linux / non-macOS installs. */
const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");

/** Shape of the OAuth blob stored in the Keychain / credentials file. */
export interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: string;
    subscriptionType?: string;
  };
}

/**
 * Read the Claude Code OAuth credentials. On macOS they live only in the login
 * Keychain; elsewhere Claude Code writes ~/.claude/.credentials.json. Try the
 * Keychain first, then the file. Rejects with a friendly Error otherwise.
 */
export async function readClaudeCredentials(): Promise<ClaudeCredentials> {
  if (process.platform === "darwin") {
    try {
      return await readKeychainCredentials();
    } catch (err) {
      // Fall through to the file only if the Keychain tool itself is missing;
      // otherwise surface the Keychain error (missing entry, locked, etc.).
      if (!(err instanceof UsageCredentialError) || !err.tryFile) throw err;
    }
  }
  return await readFileCredentials();
}

function readKeychainCredentials(): Promise<ClaudeCredentials> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          const code = err.code;
          // ONLY the `security` binary being absent (non-macOS / not on PATH)
          // may fall back to the on-disk credentials file. Node reports this as
          // a string "ENOENT" code; a real Keychain error carries a numeric
          // exit code instead.
          if (code === "ENOENT") {
            reject(new UsageCredentialError("security_missing", true));
            return;
          }
          // Operational Keychain failures (item-not-found, locked, access
          // denied, timeout) must NOT fall back to a possibly-stale on-disk
          // credential — surface an actionable message instead.
          reject(new UsageCredentialError(keychainErrorKind(err, stderr), false));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          if (!parsed || typeof parsed !== "object") {
            reject(new UsageCredentialError("malformed", false));
            return;
          }
          resolve(parsed as ClaudeCredentials);
        } catch {
          reject(new UsageCredentialError("keychain_json", false));
        }
      },
    );
  });
}

/** Map a `security` non-ENOENT failure to a fixed, actionable message (English). */
export function keychainErrorMessage(err: ExecFileException, stderr: string | Buffer | undefined): string {
  return CREDENTIAL_MESSAGES[keychainErrorKind(err, stderr)];
}

/** Which fixed failure a `security` non-ENOENT exit is. */
function keychainErrorKind(err: ExecFileException, stderr: string | Buffer | undefined): CredentialFailure {
  // When Node's own execFile `timeout` fires, it kills the child and sets
  // killed=true WITH the kill signal — that pair is the timeout signature.
  // Require both: a child terminated externally by SIGTERM has killed=false
  // (Node didn't kill it), so it must NOT be mislabeled a timeout — it falls
  // through to the generic message. Checked first because a timeout usually
  // leaves stderr empty, which the stderr branches can't distinguish.
  if (err.killed === true && err.signal != null) {
    return "keychain_timeout";
  }
  const code = err.code;
  const text = String(stderr ?? "").toLowerCase();
  // errSecItemNotFound → exit 44, or the tool prints "could not be found".
  if (code === 44 || code === "44" || text.includes("could not be found")) {
    return "keychain_not_found";
  }
  if (text.includes("interaction is not allowed") || text.includes("denied") || text.includes("locked")) {
    return "keychain_locked";
  }
  return "keychain_unreadable";
}

async function readFileCredentials(): Promise<ClaudeCredentials> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_FILE, "utf-8");
  } catch {
    throw new UsageCredentialError("file_missing", false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageCredentialError("file_json", false);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new UsageCredentialError("malformed", false);
  }
  return parsed as ClaudeCredentials;
}

/** Why the Claude Code credentials could not be read: each is a fixed message of ours. */
type CredentialFailure =
  | "security_missing" | "keychain_timeout" | "keychain_not_found" | "keychain_locked" | "keychain_unreadable"
  | "keychain_json" | "malformed" | "file_missing" | "file_json";

/** The English text of each (the web card's message; also `Error.message`). */
const CREDENTIAL_MESSAGES: Record<CredentialFailure, string> = {
  security_missing: "`security` command not found on PATH.",
  keychain_timeout: "the macOS Keychain lookup timed out — unlock the Keychain and try /usage again.",
  keychain_not_found: "no Claude Code credentials in the macOS Keychain. Log in with Claude Code first.",
  keychain_locked: "the macOS Keychain is locked or denied access — unlock it and try /usage again.",
  keychain_unreadable: "could not read Claude Code credentials from the macOS Keychain.",
  keychain_json: "Keychain credentials were not valid JSON.",
  malformed: "Claude Code credentials were malformed. Re-login to Claude Code (`claude` → /login).",
  file_missing: "no Claude Code credentials found. Log in with Claude Code first.",
  file_json: "Claude Code credentials file was not valid JSON.",
};

/** A credential failure, in the reply's language. */
export function credentialFailureText(t: OwnerT<"usage">, kind: CredentialFailure): OwnerText {
  switch (kind) {
    case "security_missing": return t("failure.credential.securityMissing");
    case "keychain_timeout": return t("failure.credential.keychainTimeout");
    case "keychain_not_found": return t("failure.credential.keychainNotFound");
    case "keychain_locked": return t("failure.credential.keychainLocked");
    case "keychain_unreadable": return t("failure.credential.keychainUnreadable");
    case "keychain_json": return t("failure.credential.keychainJson");
    case "malformed": return t("failure.malformed");
    case "file_missing": return t("failure.credential.fileMissing");
    case "file_json": return t("failure.credential.fileJson");
  }
}

/** Credential-loading failure: a fixed kind, so the reply can be written in any language. */
export class UsageCredentialError extends Error {
  constructor(readonly kind: CredentialFailure, readonly tryFile: boolean) {
    super(CREDENTIAL_MESSAGES[kind]);
    this.name = "UsageCredentialError";
  }
}

/**
 * Surface only our own curated credential messages; anything else collapses to
 * a fixed string. This structurally guarantees no arbitrary err.message (which
 * a future layer could populate with sensitive data) reaches the chat.
 */
