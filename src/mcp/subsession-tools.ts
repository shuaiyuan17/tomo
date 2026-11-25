import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EFFORT_LEVELS } from "../config.js";
import type { SubsessionService } from "../agent/subsessions/service.js";
import { currentStep, DONE_STEPS_KEEP, oneLine, OPEN_STATUSES, PLAN_MAX_STEPS, PLAN_STEP_MAX, PROGRESS_TEXT_MAX, STEP_RESULT_MAX, type SubsessionRecord } from "../agent/subsessions/types.js";

/** The task_* tools a sub-session reports through (its own session only). */
export const SUBSESSION_SELF_TOOL_NAMES = ["task_reply", "task_notify", "task_ask", "task_plan", "task_update", "task_checkpoint", "task_finish", "task_reopen", "task_status"] as const;
/** The owning session's tools (the owner's DM only, for now). */
export const SUBSESSION_OWNER_TOOL_NAMES = ["task_spawn", "task_status", "task_cancel", "task_message"] as const;
/** Every task tool name, once: for the SDK's allowedTools. */
export const SUBSESSION_TASK_TOOL_NAMES = [...new Set([...SUBSESSION_SELF_TOOL_NAMES, ...SUBSESSION_OWNER_TOOL_NAMES])];

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (name: string, text: string) => ({ content: [{ type: "text" as const, text: `${name} failed: ${text}` }], isError: true });

function ago(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** `background`: waiting(external) with its own background work still running (SubsessionService.backgroundRunning). */
function statusLabel(r: SubsessionRecord, background: boolean): string {
  if (background) return "working (background task running)";
  return r.status === "waiting" ? `waiting (${r.waitingOn ?? "owner"})` : r.status;
}

/** One line per task, for the owning session's list. */
export function formatTaskLine(r: SubsessionRecord, now = Date.now(), background = false): string {
  const step = currentStep(r);
  const onStep = step ? ` · ${step}` : "";
  return `${r.id} [${statusLabel(r, background)}] ${r.title}${onStep} (active ${ago(r.lastActivityAt, now)})`;
}

/** The whole record, as the task or its owning session reads it. */
export function formatTaskDetail(r: SubsessionRecord, now = Date.now(), background = false): string {
  const reason = r.waitingReason ? (background ? ` — when that is done: ${r.waitingReason}` : ` — ${r.waitingReason}`) : "";
  const lines = [
    `${r.id}: ${r.title}`,
    `Status: ${statusLabel(r, background)}${reason}`,
    `Created ${ago(r.createdAt, now)}, last activity ${ago(r.lastActivityAt, now)}`,
  ];
  if (r.model) lines.push(`Model: ${r.model}`);
  if (r.plan?.length && OPEN_STATUSES.has(r.status)) {
    lines.push("Plan (steps still ahead):");
    for (const step of r.plan) lines.push(`- [${step.status === "in_progress" ? "in progress" : "not started"}] ${step.text}`);
  }
  const doneSteps = (r.doneSteps ?? []).slice(-5);
  if (doneSteps.length > 0) {
    lines.push("Steps done (newest last):");
    for (const e of doneSteps) lines.push(`- ${new Date(e.at).toISOString()}: ${e.text}${e.result ? ` — ${e.result}` : ""}`);
  }
  const updates = (r.updates ?? []).slice(-5);
  if (updates.length > 0) {
    lines.push("Decisions and updates (newest last):");
    for (const e of updates) lines.push(`- ${new Date(e.at).toISOString()}: ${e.kind === "plan" ? `Plan changed: ${e.text}` : e.text}`);
  }
  if (r.checkpoint) lines.push("Checkpoint:", r.checkpoint);
  for (const e of r.earlierReports ?? []) lines.push(`Earlier report #${e.seq} (replaced by a later one before it was read):`, e.text);
  if (r.report) lines.push(r.reportSeq ? `Report #${r.reportSeq}:` : "Report:", r.report);
  if (r.sent.length > 0) {
    lines.push("Messages sent to the owner (newest last):");
    for (const m of r.sent.slice(-5)) lines.push(`- ${new Date(m.at).toISOString()}: ${m.text}`);
  }
  const recent = r.transitions.slice(-5);
  if (recent.length > 0) {
    lines.push("Recent status changes:");
    for (const t of recent) lines.push(`- ${new Date(t.at).toISOString()}: ${t.from ?? "(new)"} → ${t.to} on ${t.event}${t.reason ? ` (${t.reason})` : ""}`);
  }
  return lines.join("\n");
}

/**
 * A sub-session's own tools. Bound to its key: a task reads and changes only
 * its own record, and speaks only to its owning scope (resolved from the
 * record's parentKey by the service, never chosen by the model).
 */
export function buildTaskSelfTools(deps: { service: () => SubsessionService | undefined; key: string }) {
  const service = (name: string): { ok: true; s: SubsessionService } | { ok: false; error: ReturnType<typeof fail> } => {
    const s = deps.service();
    return s ? { ok: true, s } : { ok: false, error: fail(name, "sub-sessions are not available right now.") };
  };
  return [
    tool(
      "task_reply",
      "Answer a message the owner sent you (<tomo-event type=\"subsession-owner-message\">). Once per message. The harness adds the [id · title] prefix. A MEDIA:/path line attaches a file.",
      { text: z.string().min(1).max(4000).describe("The answer, in the owner's language, casual and concise. Lead with the answer.") },
      async ({ text }) => {
        const r = service("task_reply");
        if (!r.ok) return r.error;
        const result = await r.s.reply(deps.key, text);
        return result.ok ? ok("Sent.") : fail("task_reply", result.error ?? "the message did not go out.");
      },
      { alwaysLoad: true, searchHint: "task reply answer owner message" },
    ),
    tool(
      "task_ask",
      "Ask the owner something only they can decide, and pause the task until they answer: a yes for something that sends, posts, pays, deletes or can't be undone, or a choice the brief leaves open. Ask one question, with the options. End the turn after it; their answer arrives as a message from them.",
      { question: z.string().min(1).max(4000).describe("The question, in the owner's language, with the options and what each sets off.") },
      async ({ question }) => {
        const r = service("task_ask");
        if (!r.ok) return r.error;
        const result = await r.s.ask(deps.key, question);
        return result.ok ? ok("Asked. The task now waits for the owner; end this turn.") : fail("task_ask", result.error ?? "the question did not go out.");
      },
      { alwaysLoad: true, searchHint: "task ask owner question decision approval" },
    ),
    tool(
      "task_notify",
      "Send the owner a message from this task. Only for a result, a decision they must make, or something that blocks you; never for progress (that is task_plan). The harness adds the [id · title] prefix. A MEDIA:/path line attaches a file.",
      { text: z.string().min(1).max(4000).describe("The message, in the owner's language, casual and concise. Lead with the point.") },
      async ({ text }) => {
        const r = service("task_notify");
        if (!r.ok) return r.error;
        const result = await r.s.notify(deps.key, text);
        return result.ok ? ok("Sent.") : fail("task_notify", result.error ?? "the message did not go out.");
      },
      { alwaysLoad: true, searchHint: "task notify owner message result decision blocked" },
    ),
    tool(
      "task_plan",
      "Set the steps still ahead, in order, replacing the plan before (an empty list clears it). Mark the one you are on in_progress (at most one). Move each step you just finished into `done`, with a one-line result (a step in `done` is not also kept ahead; to do it again, add it in a later call, in new words). Silent: the owner sees the plan and the finished steps when they look. Set it when you start, and keep it current. Give each step its own words (no two alike), keep them the same from call to call and add new steps at the end; to drop, reword or reorder a step still ahead, give `reason` (one line), which the owner sees under Decisions and updates.",
      {
        steps: z.array(z.object({
          step: z.string().min(1).max(2000).describe(`One short line: what this step gets done (cut at ${PLAN_STEP_MAX} characters).`),
          status: z.enum(["pending", "in_progress"]).optional().describe("in_progress for the step you are on; default pending."),
        })).max(PLAN_MAX_STEPS).describe("The steps still ahead, in order. Not the finished ones."),
        done: z.array(z.object({
          step: z.string().min(1).max(2000).describe("The step, as it stood in the plan."),
          result: z.string().max(2000).optional().describe(`One line: what came of it (cut at ${STEP_RESULT_MAX} characters).`),
        })).max(DONE_STEPS_KEEP).optional().describe("Steps finished since the last task_plan call."),
        reason: z.string().max(2000).optional().describe("Required when this drops, rewords or reorders a step still ahead: one line on why the plan changed."),
      },
      async ({ steps, done, reason }) => {
        const r = service("task_plan");
        if (!r.ok) return r.error;
        if (steps.filter((s) => s.status === "in_progress").length > 1) return fail("task_plan", "at most one step can be in_progress.");
        if (steps.some((s) => !oneLine(s.step, PLAN_STEP_MAX)) || (done ?? []).some((d) => !oneLine(d.step, PLAN_STEP_MAX))) return fail("task_plan", "a step is blank. Nothing was saved.");
        const outcome = r.s.setPlan(deps.key, steps, done ?? [], reason);
        if (outcome.ok) return ok("Plan saved.");
        if (outcome.error === "duplicate_step") return fail("task_plan", "two steps read the same. Give each step its own words (for example \"Run the tests again\" for the second). Nothing was saved.");
        return fail("task_plan", outcome.error === "reason_required"
          ? "this drops, rewords or reorders a step still ahead. Give `reason` (one line on why the plan changed), or keep those steps as they were and add new ones at the end. Nothing was saved."
          : "no task record for this session.");
      },
      { alwaysLoad: true, searchHint: "task plan steps checklist todo" },
    ),
    tool(
      "task_update",
      "Record a decision or a change the owner should know about: the scope changed, an approach was chosen (and why, briefly), you are blocked or unblocked, a finding that changes the plan. Kept with its time and shown to the owner as \"Decisions and updates\". Silent (not a message). Not for routine progress: that is task_plan.",
      { line: z.string().min(1).max(2000).describe("One line: what was decided or what changed (cut at 300 characters).") },
      async ({ line }) => {
        const r = service("task_update");
        if (!r.ok) return r.error;
        if (!oneLine(line, PROGRESS_TEXT_MAX)) return fail("task_update", "the line is blank. Nothing was saved.");
        return r.s.postUpdate(deps.key, line) ? ok("Update saved.") : fail("task_update", "no task record for this session.");
      },
      { alwaysLoad: true, searchHint: "task update decision change blocked scope" },
    ),
    tool(
      "task_checkpoint",
      "Save the task's goal, progress, next step and every side effect so far (commits, pushes, PRs, messages, files) to the task record. It survives compaction and restarts; call it before a big step.",
      { summary: z.string().min(1).max(8000) },
      async ({ summary }) => {
        const r = service("task_checkpoint");
        if (!r.ok) return r.error;
        return r.s.checkpoint(deps.key, summary) ? ok("Checkpoint saved.") : fail("task_checkpoint", "no task record for this session.");
      },
      { alwaysLoad: true, searchHint: "task checkpoint save state side effects" },
    ),
    tool(
      "task_finish",
      "The task is done. The report goes to the main session, which tells the owner and decides what to remember. Put the result first, then what changed (links, PRs, files), then anything worth remembering. Scheduled check-backs of this task are removed. Refused while a message you have not read yet is waiting: it comes in your next turn; handle it, then finish.",
      { report: z.string().min(1).max(20000) },
      async ({ report }) => {
        const r = service("task_finish");
        if (!r.ok) return r.error;
        const outcome = r.s.finish(deps.key, report);
        if (outcome.ok) return ok("Finished. The main session has the report.");
        if ("unread" in outcome) {
          const n = outcome.unread;
          return fail("task_finish", `not finished: you still have ${n} unread message${n === 1 ? "" : "s"} (from the owner, the main session, or a check-back) that arrived after this turn started. ${n === 1 ? "It is" : "They are"} delivered to you in your next turn: end this turn, handle ${n === 1 ? "it" : "them"}, then call task_finish again.`);
        }
        return fail("task_finish", `this task is ${outcome.from ?? "unknown"}; it cannot finish from there.`);
      },
      { alwaysLoad: true, searchHint: "task finish done report" },
    ),
    tool(
      "task_reopen",
      "Reopen this task after task_finish, when the owner asks for more work on it.",
      {},
      async () => {
        const r = service("task_reopen");
        if (!r.ok) return r.error;
        const outcome = r.s.reopen(deps.key);
        return outcome.ok ? ok("Reopened.") : fail("task_reopen", `this task is ${outcome.from ?? "unknown"}; only a finished task can be reopened.`);
      },
      { searchHint: "task reopen more work" },
    ),
    tool(
      "task_status",
      "Read this task's record: status, plan, steps done, decisions and updates, checkpoint, and the messages it sent the owner.",
      {},
      async () => {
        const r = service("task_status");
        if (!r.ok) return r.error;
        const record = r.s.byKey(deps.key);
        return record ? ok(formatTaskDetail(record, Date.now(), r.s.backgroundRunning(record))) : fail("task_status", "no task record for this session.");
      },
      { alwaysLoad: true, searchHint: "task status record" },
    ),
  ];
}

/**
 * The owning session's tools. `scope()` is the scope the turn in flight
 * speaks for, or undefined when it may not use them (a summoned group's turn,
 * a mixed batch): resolved per call, like the cron tools. Every task lookup
 * checks the record's parentKey against it, so a scope only ever sees and
 * steers its own tasks.
 */
export function buildTaskOwnerTools(deps: { service: () => SubsessionService | undefined; scope: () => string | undefined }) {
  const context = (name: string): { ok: true; s: SubsessionService; scope: string } | { ok: false; error: ReturnType<typeof fail> } => {
    const s = deps.service();
    if (!s || !s.available()) return { ok: false, error: fail(name, "sub-sessions are not enabled.") };
    const scope = deps.scope();
    if (!scope) return { ok: false, error: fail(name, "this turn cannot manage sub-sessions; do it from the owner's own conversation.") };
    return { ok: true, s, scope };
  };
  const own = (s: SubsessionService, scope: string, id: string) => {
    const record = s.get(id.trim());
    return record && record.parentKey === scope ? record : undefined;
  };
  return [
    tool(
      "task_spawn",
      [
        "Start a sub-session: a separate session that works on one long task in the background and reports back. For work that takes many steps or a long time (a PR to write and see through review, a long investigation), so this conversation stays free. Not for a quick question.",
        "",
        "The task gets no memory and none of this conversation: `brief` must say everything it needs (goal, where things are, what done looks like, what it may do without asking). Put the owner's own words about the task in `quote`, verbatim, so the task sees what they actually asked.",
        "",
        "When you start a task on your own (the owner did not ask for one), you must tell the owner first, in this conversation, what you are starting and why. Never start one silently.",
        "",
        "It starts when a slot is free. It reports with task_finish; you get the report as a note and tell the owner.",
      ].join("\n"),
      {
        title: z.string().min(1).max(80).describe("A few words naming the task, in the owner's language."),
        brief: z.string().min(1).max(20000),
        quote: z.array(z.string().min(1).max(4000)).max(10).optional().describe("The owner's messages about this task, verbatim."),
        model: z.string().optional().describe("opus (default), sonnet for routine work, fable when the owner asks for it. No haiku."),
        effort: z.enum(EFFORT_LEVELS).optional(),
      },
      async ({ title, brief, quote, model, effort }) => {
        const c = context("task_spawn");
        if (!c.ok) return c.error;
        const result = c.s.spawn(c.scope, { title: title.trim(), brief, ...(quote ? { quote } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        if (!result.ok) return fail("task_spawn", result.error);
        return ok(`Started ${result.record.id} (${result.record.status}). Its messages show as [${result.record.id} · ${result.record.title}].`);
      },
      { alwaysLoad: true, searchHint: "sub-session spawn start background long task delegate" },
    ),
    tool(
      "task_status",
      "List this conversation's sub-sessions, or read one in full (status, progress, checkpoint, report, messages it sent).",
      { id: z.string().optional().describe("A task id such as s3. Omit to list them all.") },
      async ({ id }) => {
        const c = context("task_status");
        if (!c.ok) return c.error;
        if (id) {
          const record = own(c.s, c.scope, id);
          return record ? ok(formatTaskDetail(record, Date.now(), c.s.backgroundRunning(record))) : fail("task_status", `no task ${id} in this conversation.`);
        }
        const tasks = c.s.list(c.scope);
        return ok(tasks.length === 0 ? "No sub-sessions." : tasks.map((t) => formatTaskLine(t, Date.now(), c.s.backgroundRunning(t))).join("\n"));
      },
      { alwaysLoad: true, searchHint: "sub-session task status list progress report" },
    ),
    tool(
      "task_cancel",
      "Cancel a sub-session: its turn is stopped, its check-backs removed, and it will not run again.",
      { id: z.string().min(1), reason: z.string().max(300).optional() },
      async ({ id, reason }) => {
        const c = context("task_cancel");
        if (!c.ok) return c.error;
        const record = own(c.s, c.scope, id);
        if (!record) return fail("task_cancel", `no task ${id} in this conversation.`);
        const outcome = await c.s.cancel(record.id, reason ?? "cancelled from the main session");
        if (!outcome.ok) return fail("task_cancel", `${record.id} is ${outcome.from ?? "unknown"}; there is nothing to cancel.`);
        return ok(outcome.changed ? `Cancelled ${record.id}.` : `${record.id} was already cancelled.`);
      },
      { searchHint: "sub-session cancel stop task" },
    ),
    tool(
      "task_message",
      "Pass something to a sub-session: the owner's answer to its question, a change of plan. It arrives as a relay from you, not as the owner's own words, so it never counts as the owner's yes to something risky. A queued task gets it with its first turn.",
      { id: z.string().min(1), text: z.string().min(1).max(8000) },
      async ({ id, text }) => {
        const c = context("task_message");
        if (!c.ok) return c.error;
        const record = own(c.s, c.scope, id);
        if (!record) return fail("task_message", `no task ${id} in this conversation.`);
        const outcome = c.s.relay(record.id, text);
        if (!outcome.ok && outcome.refused) return fail("task_message", `${record.id} was not given the message: ${outcome.refused}. Wait for it to catch up, or cancel it.`);
        if (!outcome.ok) return fail("task_message", `${record.id} is ${outcome.from ?? "unknown"}; it takes no more messages.`);
        return ok(outcome.record.status === "queued" ? `${record.id} is queued; it gets the message with its first turn.` : `Passed to ${record.id}.`);
      },
      { searchHint: "sub-session message relay answer task" },
    ),
  ];
}
