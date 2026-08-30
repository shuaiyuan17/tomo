import { isDmSessionKey } from "../sessions/keys.js";
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
 * - the job's own session may always manage it;
 * - a `dm:` caller is the owner, and may additionally manage group-keyed jobs
 *   and jobs with no session key — but never another identity's `dm:` jobs;
 * - every other caller (a group session) may manage only its own jobs. A
 *   group must never be able to reach into a DM, another group, or an
 *   unattributed job.
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
  if (!isDmSessionKey(callerSessionKey)) return false;
  // A dm: caller is the owner. Anything unattributed or group-keyed is
  // theirs to manage; another identity's DM jobs are not.
  if (!owner) return true;
  return !isDmSessionKey(owner);
}
