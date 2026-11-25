/**
 * The high-context spawn gate: once a session's context usage reaches
 * `lcm.blockSpawnAtPct`, launching a NEW background subagent is refused.
 *
 * Why: a compact (lcm rollup / compact) reloads the session, which would kill
 * its background tasks, so the rollup gate defers it while any is running
 * (compact-reservations.ts, lcm/background-gate.ts). A session that keeps
 * starting one background agent after another therefore never gets compacted
 * and rides its context into the wall ("Prompt is too long"). Refusing new
 * background agents above the threshold lets the running ones drain, and the
 * compact through.
 *
 * Every session type is gated, by the owner's choice: one rule, "no new
 * background agents past 80%". On a session the harness does not compact with
 * lcm (an SDK-compacted group, a sub-session) the refusal says so instead of
 * pointing at lcm, and an SDK compact lifts the gate at once (the reading it
 * made stale counts as unknown — LiveSession.compactedSinceLastResult).
 *
 * What it does NOT touch: SendMessage (resuming / talking to an agent that
 * already exists), a foreground Agent call (`run_in_background: false`, which
 * ends inside the turn and never holds a compact off), every other tool
 * (task_spawn starts a separate session with its own context; the lcm
 * commands are Bash), and the agents already running.
 *
 * The usage read is the context nudger's own: the live session's last turn
 * result (`LiveSessionManager.lastResult`), `contextUsed / contextMax`, and a
 * reading the SDK could not supply (`contextEstimated`) counts as unknown, not
 * low or high — exactly as `ContextNudger.maybeNudgeCompact` treats it. A
 * compact reloads the session, and the fresh session has no reading until its
 * first turn ends, so the gate cannot stay shut on a stale pre-compact number.
 * It compares live on every call: no latch, it lifts as soon as usage is back
 * under the threshold.
 */

/** Tool names the SDK uses for a subagent launch (`Task` is the older name). */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * Does this Agent/Task call start a subagent that runs in the background? The
 * SDK's Agent tool runs in the background BY DEFAULT: only an explicit
 * `run_in_background: false` keeps it in the foreground, and remote isolation
 * is always background.
 */
export function agentRunsInBackground(toolInput: unknown): boolean {
  if (toolInput === null || typeof toolInput !== "object") return true;
  const input = toolInput as { run_in_background?: unknown; isolation?: unknown };
  if (input.isolation === "remote") return true;
  return input.run_in_background !== false;
}

/** Is this tool call the launch of a new background subagent? */
export function launchesBackgroundSubagent(toolName: string, toolInput: unknown): boolean {
  return SUBAGENT_TOOLS.has(toolName) && agentRunsInBackground(toolInput);
}

/** The context reading the gate looks at — the nudger's QueryResult fields. */
export interface ContextReading {
  contextUsed: number;
  contextMax: number;
  contextEstimated?: boolean;
}

/** Is `pct` an active threshold? 0 and 100 (and anything outside) mean off. */
export function spawnGateEnabled(pct: number): boolean {
  return Number.isFinite(pct) && pct > 0 && pct < 100;
}

/**
 * The refusal the model reads. English, like every tool result (CLAUDE.md,
 * i18n: text for the model is not translated); the model relays it in the
 * conversation's language.
 */
export function spawnGateMessage(pct: number, lcmManaged = true): string {
  const first = lcmManaged
    ? "compact first (lcm compact / daily rollup), then start new background agents"
    : "no new background agents until this session is compacted";
  return `Context is at ${pct}%: ${first}. ` +
    "Agents already running are unaffected; SendMessage to them, and a foreground agent (run_in_background: false), still work.";
}

/**
 * Why a new background subagent must be refused right now, or null. Unknown
 * usage (no reading yet, no window, an estimated reading) never blocks.
 */
export function spawnDenial(reading: ContextReading | null | undefined, blockAtPct: number, lcmManaged = true): string | null {
  if (!spawnGateEnabled(blockAtPct)) return null;
  if (!reading || !(reading.contextMax > 0) || reading.contextEstimated) return null;
  const usedFrac = reading.contextUsed / reading.contextMax;
  if (usedFrac < blockAtPct / 100) return null;
  return spawnGateMessage(Math.round(usedFrac * 100), lcmManaged);
}
