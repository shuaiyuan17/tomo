/**
 * Why a sub-session's turn failed, as a short category the owning session can
 * act on (resume, or start over clean). Read from what the turn left: the
 * SDK's refusal category, its typed API error, and the short error text.
 */

/** What a failed task turn left behind (see TaskTurnOutcome.failure). */
export interface TurnFailure {
  /** The model's refusal category (e.g. reasoning_extraction), when it refused. */
  refusal?: string;
  /** The SDK's typed API error kind (e.g. invalid_request), "unknown" dropped. */
  errorKind?: string;
  /** The short error text (never stderr or payloads). */
  detail?: string;
}

const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const DETAIL_MAX = 300;

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return CATEGORY.test(v) ? v : undefined;
}

/**
 * The category: the refusal's own, else one named in the error text (a
 * refusal category, then the API error's type without `_error`), else the
 * SDK's error kind, else "prompt_too_long" for a context overflow. Undefined
 * when nothing says. `refused`: it is a refusal's category.
 */
export function classifyFailure(f: TurnFailure | undefined): { category?: string; refused?: true } {
  if (!f) return {};
  const refusal = clean(f.refusal);
  if (refusal) return { category: refusal, refused: true };
  const detail = f.detail ?? "";
  const named = clean(/"(?:api_refusal_category|refusal_category)"\s*:\s*"([a-z0-9_]+)"/i.exec(detail)?.[1]);
  if (named) return { category: named, refused: true };
  // The innermost error type: {"type":"error","error":{"type":"invalid_request_error",…}}.
  const types = [...detail.matchAll(/"type"\s*:\s*"([a-z0-9_]+)"/gi)].map((m) => m[1].toLowerCase()).filter((t) => t !== "error");
  const type = types.at(-1);
  if (type && clean(type)) return { category: type.replace(/_error$/, "") };
  const kind = clean(f.errorKind);
  if (kind && kind !== "unknown") return { category: kind };
  if (/prompt is too long|context window/i.test(detail)) return { category: "prompt_too_long" };
  return {};
}

export function failureCategory(f: TurnFailure | undefined): string | undefined {
  return classifyFailure(f).category;
}

/** A refusal, an invalid request, a context overflow: the conversation itself is what fails. */
const CONTAMINATED = "Its conversation itself is what fails, so resuming it will likely fail again: cancel it and start the work over as a new task (task_spawn) with a clean brief.";

/**
 * What a category means for picking the task up again, for the owning
 * session. `refused`: the category is the model's refusal category (any
 * name: the set is the API's, and open).
 */
export function failureHint(category: string | undefined, refused = false): string {
  if (refused) return CONTAMINATED;
  switch (category) {
    case undefined:
      return "The cause is not known; one more try may work, and if it fails again, start the work over as a new task.";
    case "rate_limit":
    case "overloaded":
    case "server_error":
      return "This looks passing (the API was busy or failing): resuming it later should work.";
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
    case "billing_error":
    case "cloud_credential_error":
      return "This is the account, not the task: the owner has to fix it before any task can run.";
    case "answer_undelivered":
      return "Its answer to the owner could not be delivered (not a model error): resuming it retries the answer.";
    case "model_not_found":
      return "The model it runs on is not available: that is the configuration, not the task. Change its model (/s <id> model …) or the default, then resume it; a new task on the same model would fail too.";
    case "invalid_request":
    case "prompt_too_long":
      return CONTAMINATED;
    case "max_output_tokens":
      return "A reply ran past the output limit: resuming with a narrower step may work.";
    default:
      return "Not a cause the harness knows: one more try may work; if it fails the same way again, start the work over as a new task.";
  }
}

/** The error text, cut for a note. */
export function failureDetail(f: TurnFailure | undefined): string | undefined {
  const d = f?.detail?.trim();
  if (!d) return undefined;
  return d.length > DETAIL_MAX ? `${d.slice(0, DETAIL_MAX - 1)}…` : d;
}
