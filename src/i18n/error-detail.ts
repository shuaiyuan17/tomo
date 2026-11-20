import { shortErrorMessage } from "../error-text.js";
import { FileLockTimeoutError } from "../file-lock.js";
import { TodoStoreConflictError, TodoStoreReadError } from "../todos/store.js";
import { RewindError } from "../agent/session-rewind.js";
import { ClaudeLoginError } from "../agent/claude-login.js";
import { McpLoginError } from "../mcp/oauth.js";
import { ownerLocale, ownerT, type Locale, type OwnerT } from "./index.js";

/**
 * An error as the owner reads it inside a reply ("Could not rewind: …").
 * Our own failures carry a kind and are translated; their English text is
 * the error's `.message`, unchanged. Anything else (an OS, SDK, HTTP or
 * OAuth-provider error, or a value of theirs inside ours) is that system's
 * own words, shown as written: `shortErrorMessage`.
 */
export function errorDetail(err: unknown, locale: Locale = ownerLocale()): string {
  const t = ownerT("errors", locale);
  if (err instanceof FileLockTimeoutError) {
    return err.holderPid === null
      ? t("lockTimeout", { path: err.path, ms: err.timeoutMs })
      : t("lockTimeoutHeld", { path: err.path, ms: err.timeoutMs, pid: err.holderPid });
  }
  if (err instanceof TodoStoreReadError) return t("todoStore.read", { path: err.path, detail: err.detail });
  if (err instanceof TodoStoreConflictError) return t("todoStore.conflict", { path: err.path });
  if (err instanceof RewindError) return rewindText(t, err);
  if (err instanceof ClaudeLoginError) return claudeLoginText(t, err);
  if (err instanceof McpLoginError) return mcpLoginText(t, err);
  return shortErrorMessage(err);
}

function rewindText(t: OwnerT<"errors">, err: RewindError): string {
  const failure = err.failure;
  switch (failure.kind) {
    case "usage": return t("rewind.usage");
    case "invalid_session": return t("rewind.invalidSession");
    case "changed": return t("rewind.changed");
    case "writing": return t("rewind.writing");
    case "kept_changing": return t("rewind.keptChanging");
    case "unreadable": return t("rewind.unreadable");
    case "too_few": return t("rewind.tooFew", { count: failure.count });
    case "boundary": return t("rewind.boundary");
    case "no_completed_turn": return t("rewind.noCompletedTurn");
    case "branch_not_removed": return t("rewind.branchNotRemoved");
    case "stopping": return t("rewind.stopping");
    case "no_conversation": return t("rewind.noConversation");
    case "in_progress": return t("rewind.inProgress");
  }
}

function claudeLoginText(t: OwnerT<"errors">, err: ClaudeLoginError): string {
  const failure = err.failure;
  switch (failure.kind) {
    case "other_owner_in_progress": return t("login.otherOwnerInProgress");
    case "expired": return t("login.expired");
    case "submit_failed": return t("login.submitFailed", { detail: failure.detail });
    case "start_failed": return t("login.startFailed", { detail: failure.detail });
    case "exited": return failure.signal
      ? t("login.exitedSignal", { signal: failure.signal })
      : t("login.exitedCode", { code: failure.code ?? "unknown" });
    case "none_waiting": return t("login.noneWaiting");
    case "other_owner": return t("login.otherOwner");
    case "verifying": return t("login.verifying");
    case "invalid_code": return t("login.invalidCode");
    case "state_mismatch": return t("login.stateMismatch");
    case "cancelled": return t("login.cancelled");
    case "stopped": return t("login.stopped");
    case "verification_failed": return failure.detail
      ? t("login.verificationFailedDetail", { detail: failure.detail })
      : t("login.verificationFailed");
  }
}

function mcpLoginText(t: OwnerT<"errors">, err: McpLoginError): string {
  switch (err.kind) {
    case "unknown_server": return t("mcpLogin.unknownServer", { server: err.server });
    case "no_oauth": return t("mcpLogin.noOAuth", { server: err.server });
    case "no_headers": return t("mcpLogin.noHeaders", { server: err.server });
    case "not_interactive": return t("mcpLogin.notInteractive", { server: err.server });
  }
}
