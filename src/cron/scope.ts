import { isCanonicalDmSessionKey, isDmSessionKey, parseRawSessionKey } from "../sessions/keys.js";
import type { CronJob } from "./types.js";

/**
 * May `callerSessionKey` administer `job`?
 *
 * Cron jobs are addressed by the session they deliver into, but the MCP
 * server is built for the session the *turn* runs on — and those differ: a
 * summoned group's background turns run on the owner's `dm:` session while
 * the jobs they manage carry the group key. A naive "sessionKey must equal
 * the caller" check would leave the owner unable to touch jobs they created
 * for their own groups, and would leave jobs with no session key (legacy
 * records, jobs orphaned by a rewrite) administrable by nobody.
 *
 * The rule:
 * - the job's own session may always manage it — this branch is plain string
 *   equality and needs no notion of ownership;
 * - a *canonical* `dm:` caller is an owner, and may additionally manage
 *   group-keyed jobs and jobs with no session key — but never another
 *   identity's `dm:` jobs;
 * - every other caller (a group session, or a malformed `dm:`-prefixed key)
 *   may manage only its own jobs. A group must never be able to reach into a
 *   DM, another group, or an unattributed job.
 *
 * The extra authority requires `isCanonicalDmSessionKey` (`^dm:[a-z0-9_-]+$`)
 * rather than the prefix test, so a crafted key cannot claim owner powers.
 * It fails closed: an install whose identity name is not a slug (names are
 * free-form in config) keeps managing its own jobs and simply does not get
 * the cross-session privilege.
 *
 * **Why any owner DM, rather than the group's own owner.** Ideally a `dm:`
 * caller would only reach groups that identity owns. That mapping does not
 * exist to consult: config binds identities to DM chat ids, not to groups,
 * and summons (`summonGroup`) are transient runtime state that says who is
 * *currently* attached to a group, not who owns its jobs — a job for a group
 * nobody is summoned into would have no derivable owner at all. Given that,
 * any-owner-DM is the honest boundary, and a defensible one: every `dm:` key
 * belongs to an identity the operator configured themselves, the boundary
 * tomo enforces everywhere else (private people records, recall) is
 * DM-vs-group rather than DM-vs-DM, the operation is enable/disable of an
 * existing job rather than creation or retargeting (the job still delivers
 * only into its own session), and the case where cross-identity privacy
 * actually bites — one identity's DM touching another's DM jobs — is denied.
 * If a durable group-to-identity map ever lands (#319 is the likely place),
 * this is the single function to tighten.
 *
 * `callerSessionKey === undefined` means the surface is unscoped (the CLI,
 * tests): everything is allowed. Callers that want scoping must pass a key.
 *
 * Exported as one predicate so every cron tool can share it — #319 scopes
 * `schedule_list` / `schedule_create` / `schedule_remove` and should adopt
 * this same function rather than restating the rule.
 */
export function canManageJob(
  job: Pick<CronJob, "sessionKey">,
  callerSessionKey?: string,
): boolean {
  if (callerSessionKey === undefined) return true;
  const owner = job.sessionKey;
  if (owner && owner === callerSessionKey) return true;
  // Beyond its own jobs, a caller needs a well-formed owner DM key.
  if (!isCanonicalDmSessionKey(callerSessionKey)) return false;
  // Anything unattributed or group-keyed is the owner's to manage; another
  // identity's DM jobs are not. `isDmSessionKey` (the prefix test) is the
  // right check on the OWNER side: a job addressed to `dm:shuai yuan` is
  // still somebody's DM job and must stay out of reach.
  if (!owner) return true;
  return !isDmSessionKey(owner);
}

/**
 * Anything a terminal, a log line or a JSON field would rather not carry.
 * Written as a scan rather than a regex: a control-character class trips
 * `no-control-regex`, and disabling the rule to smuggle one in is worse than
 * six lines that say exactly what they reject.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Is `key` a session key we are willing to WRITE into the store?
 *
 * `schedule_create` takes the delivery target as free text from the model, and
 * that string is persisted, printed by `tomo cron`, logged, and later fed to
 * `canManageJob`. A key with a newline, a control character or no channel at
 * all is not a session anything can deliver to — it is a job that will never
 * fire, discovered much later.
 *
 * Accepted: a `dm:` key whose identity part is non-empty and colon-free, or a
 * `<channel>:<chatId>` raw key. Note the `dm:` branch is deliberately LOOSER
 * than `isCanonicalDmSessionKey`: identity names are free-form in config, so
 * `dm:shuai yuan` is a legitimate delivery target even though it is not a
 * slug. It simply does not earn owner authority in `canManageJob` — shape
 * validation for storage, strict canonical form for privilege.
 */
export function isStorableSessionKey(key: string): boolean {
  if (key.length === 0 || key !== key.trim()) return false;
  if (hasControlChars(key)) return false;
  if (isDmSessionKey(key)) {
    const identity = key.slice(3);
    return identity.length > 0 && !identity.includes(":");
  }
  return parseRawSessionKey(key) !== undefined;
}
