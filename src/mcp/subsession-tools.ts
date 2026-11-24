import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { EFFORT_LEVELS } from "../config.js";
import type { SubsessionService } from "../agent/subsessions/service.js";
import type { SubsessionRecord } from "../agent/subsessions/types.js";

/** The task_* tools a sub-session reports through (its own session only). */
export const SUBSESSION_SELF_TOOL_NAMES = ["task_notify", "task_progress", "task_checkpoint", "task_finish", "task_reopen", "task_status"] as const;
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

function statusLabel(r: SubsessionRecord): string {
  return r.status === "waiting" ? `waiting (${r.waitingOn ?? "owner"})` : r.status;
}

/** One line per task, for the owning session's list. */
export function formatTaskLine(r: SubsessionRecord, now = Date.now()): string {
  const progress = r.progress ? ` · ${r.progress}` : "";
  return `${r.id} [${statusLabel(r)}] ${r.title}${progress} (active ${ago(r.lastActivityAt, now)})`;
}

/** The whole record, as the task or its owning session reads it. */
export function formatTaskDetail(r: SubsessionRecord, now = Date.now()): string {
  const lines = [
    `${r.id}: ${r.title}`,
    `Status: ${statusLabel(r)}${r.waitingReason ? ` — ${r.waitingReason}` : ""}`,
    `Created ${ago(r.createdAt, now)}, last activity ${ago(r.lastActivityAt, now)}`,
  ];
  if (r.model) lines.push(`Model: ${r.model}`);
  if (r.progress) lines.push(`Progress: ${r.progress}`);
  if (r.checkpoint) lines.push("Checkpoint:", r.checkpoint);
  if (r.report) lines.push("Report:", r.report);
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
      "task_notify",
      "Send the owner a message from this task. Only for a result, a decision they must make, or something that blocks you; never for progress (use task_progress). The harness adds the [id · title] prefix. A MEDIA:/path line attaches a file.",
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
      "task_progress",
      "Update this task's one-line status. Silent: the owner sees it only when they look. Call it after each meaningful step.",
      { line: z.string().min(1).max(300).describe("One line: where the task stands now.") },
      async ({ line }) => {
        const r = service("task_progress");
        if (!r.ok) return r.error;
        return r.s.progress(deps.key, line) ? ok("Progress saved.") : fail("task_progress", "no task record for this session.");
      },
      { alwaysLoad: true, searchHint: "task progress status line" },
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
      "The task is done. The report goes to the main session, which tells the owner and decides what to remember. Put the result first, then what changed (links, PRs, files), then anything worth remembering. Scheduled check-backs of this task are removed.",
      { report: z.string().min(1).max(20000) },
      async ({ report }) => {
        const r = service("task_finish");
        if (!r.ok) return r.error;
        const outcome = r.s.finish(deps.key, report);
        return outcome.ok ? ok("Finished. The main session has the report.") : fail("task_finish", `this task is ${outcome.from ?? "unknown"}; it cannot finish from there.`);
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
      "Read this task's record: status, progress, checkpoint, and the messages it sent the owner.",
      {},
      async () => {
        const r = service("task_status");
        if (!r.ok) return r.error;
        const record = r.s.byKey(deps.key);
        return record ? ok(formatTaskDetail(record)) : fail("task_status", "no task record for this session.");
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
          return record ? ok(formatTaskDetail(record)) : fail("task_status", `no task ${id} in this conversation.`);
        }
        const tasks = c.s.list(c.scope);
        return ok(tasks.length === 0 ? "No sub-sessions." : tasks.map((t) => formatTaskLine(t)).join("\n"));
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
