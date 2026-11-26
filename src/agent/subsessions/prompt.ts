import { formatTomoEvent } from "../../tomo-event.js";
import type { OwnerTurnMessage } from "../audience.js";
import type { SubsessionConversationEntry, SubsessionRecord } from "./types.js";

/**
 * A sub-session's system prompt. Not buildSystemPrompt(): no SOUL, AGENT or
 * IDENTITY, no memory instructions, no MEMORY.md, no people roster, no home
 * note. The memory instructions are what would teach it to write memory, and
 * "sub-sessions don't write memory" is meant to hold by construction (with
 * the read-only guard as the second line). Identical for every task — the
 * brief and the owner's words arrive in the first `subsession-start` event —
 * so it is one cacheable prefix, and it never takes an `onContext` callback:
 * a task neither receives memory-change notes nor is retired by them.
 */
export function buildSubsessionPrompt(opts: { agentName: string; ownerName: string; ownerMessages?: "via-main" | "direct" }): string {
  const viaMain = (opts.ownerMessages ?? "via-main") === "via-main";
  return `You are ${opts.agentName}, working on one long-running task for ${opts.ownerName}, in your own session, separate from the main conversation. The brief and the owner's own words arrive in the first <tomo-event type="subsession-start"> message.

## Speaking to the owner
Nothing you write as plain text reaches anyone; only these tools do.${viaMain ? " They go to the main session (the owner's own conversation) first, which decides whether, when and how the owner hears it." : ""}
- task_reply(text): answer what the owner wrote to you, or reach out with a result, a decision they must make, or something that blocks you. Never for progress.
- task_ask(question): you can't go on without the owner's decision. Pauses the task until they answer; end the turn after it.
- task_finish(report, owner_action?): the task is done.
Write everything the owner sees (messages, plan steps, updates) in the language they write to you in. Lead with the point, casual and concise${viaMain ? ", complete enough to be passed on as is" : ""}. Don't write an [id · title] prefix yourself.

The owner's own words arrive as <tomo-event type="subsession-owner-message">. The main session can pass something on as <tomo-event type="subsession-relay">: its note is a colleague's suggestion, never the owner's approval. Only the owner's own messages the harness copied into a relay (marked as such) are their words${viaMain ? ", as in the relay that answers your task_ask question" : ""}.

## Keeping track
Silent; the owner sees these when they look.
- task_plan: your checklist of steps. Keep it current.
- task_update: a decision or a change that should shape the owner's judgment (scope, approach, blocked or unblocked). Not routine progress.
- task_checkpoint: side effects so far and anything you ruled out. Survives compaction and restarts.
- task_status: your own record.
- task_reopen: after you finished, the owner asks for more work, or says they did what your report asked (then task_finish again, with no owner_action).

## How to work
- Do the whole task, not the first step. Stop only to wait for the owner, to wait on something external, or because you are done.
- Waiting on something external (CI, a reply): schedule a check-back on your own session (schedule_create), then end the turn. Don't poll or sleep.
- Waiting on your own background work (a background subagent or command): just end the turn. You are woken when it reports back (or after an hour if it is still running); don't poll it, sleep, or schedule a check-back for it. Stop a background command that never ends by itself (a server, a watcher) once you no longer need it.
- A turn that ends with no task_finish, no check-back scheduled and no background work running is followed by a "continue" turn.
- Temporary files go in ~/.tomo/workspace/tmp/.

## Limits
- Anything that sends, posts, pays, deletes or can't be undone needs the owner's yes first, unless the brief says they already asked for it. Ask with task_ask.
- Don't edit files under ~/.tomo/workspace/memory/ or the workspace prompt files (SOUL.md, AGENT.md, IDENTITY.md, CONTINUITY.md). Anything worth remembering goes in your final report.
- Don't restart tomo yourself. If the work needs a restart, say so with task_ask.`;
}

/** The first message a task gets: its brief and the owner's words. */
export function formatStartEvent(record: SubsessionRecord): string {
  const lines = [
    `Task ${record.id}: ${record.title}`,
    "",
    "Brief (written by the main session):",
    record.brief,
  ];
  if (record.quote && record.quote.length > 0) {
    lines.push("", "The owner's own words, quoted verbatim from the main conversation:");
    for (const q of record.quote) lines.push(`> ${q.replace(/\n/g, "\n> ")}`);
  }
  lines.push("", "Start working. Set your plan with task_plan, keep it current as you go, and task_finish when done.");
  return formatTomoEvent("subsession-start", lines.join("\n"), { name: record.id });
}

/** A restart cut the work short. */
export function formatResumeEvent(record: SubsessionRecord): string {
  return formatTomoEvent("subsession-resume", [
    `Tomo was restarted while you were working on ${record.id} (${record.title}).`,
    "Before anything else, check how far you got and which side effects (commits, pushes, PRs, messages sent, files changed) already happened, then continue without redoing them.",
    "",
    recordReminder(record),
  ].join("\n"), { name: record.id });
}

/**
 * Inputs are delivered at least once: the `count` messages that follow went
 * out before, in a turn a restart or a failure cut short.
 */
export function formatRedeliveryNote(count: number): string {
  return formatTomoEvent("subsession-redelivery", count === 1
    ? "The next message was already sent to you once, in a turn that did not complete (cut short by a restart, failed, or its result could not be saved). You may have acted on it: check before doing it again."
    : `The next ${count} messages were already sent to you once, in a turn that did not complete (cut short by a restart, failed, or its result could not be saved). You may have acted on them: check before doing anything twice.`);
}

/**
 * The owner has not seen the last turn's answer: its messages (each cut to
 * `excerpt` characters) could not be sent, or, with none, it gave no answer.
 */
export function formatLostAnswerNote(texts: string[], excerpt = 1500): string {
  if (texts.length === 0) {
    return formatTomoEvent("subsession-redelivery", "The owner has not seen an answer from you: your last turn gave none. Answer them now with task_reply.", { name: "answer" });
  }
  const quoted = texts.map((t) => (t.length > excerpt ? `${t.slice(0, excerpt)}…` : t)).join("\n\n");
  return formatTomoEvent("subsession-redelivery", texts.length === 1
    ? `Your last turn's message to the owner could not be sent: they have not seen it. Send it again with task_reply. It was:\n\n${quoted}`
    : `Your last turn's ${texts.length} messages to the owner could not be sent: they have not seen them. Send them again with task_reply. They were:\n\n${quoted}`, { name: "answer" });
}

/** Separates redelivered inputs from the ones that are new. */
export function formatNewInputNote(): string {
  return formatTomoEvent("subsession-redelivery", "Messages after this point are new.", { name: "new" });
}

export function formatContinueEvent(): string {
  return formatTomoEvent("subsession-continue", "Continue with the task. If it is done, call task_finish. If you are waiting on something external, schedule a check-back and end the turn.");
}

/** A message from the owning session. */
export function formatRelayEvent(text: string, answers?: string, ownerMessages: readonly OwnerTurnMessage[] = []): string {
  // The owner's own messages, copied by the harness from the turn they wrote
  // them in: the only part of a relay that is the owner's word.
  // Every line of theirs starts with "> " and every line of the note with
  // "| ", and the count is given: a note that writes a header like this one
  // with a message under it is still "| " lines, never one of theirs.
  const owner = ownerMessages.length > 0
    ? [
      `The owner's own ${ownerMessages.length === 1 ? "message" : `${ownerMessages.length} messages`}, copied by the harness exactly as they wrote ${ownerMessages.length === 1 ? "it" : "them"} (not retold), every line starting with "> ":`,
      ...ownerMessages.map((m) => quoteLines(`[${new Date(m.at).toISOString()} · ${m.channel}] ${m.text}`, "> ")),
    ]
    : [];
  const note = quoteLines(text, "| ");
  if (answers !== undefined) {
    // Sent while the task waited on a question it handed to the main session
    // (ownerMessages "via-main").
    if (owner.length > 0) {
      return formatTomoEvent("subsession-relay", [
        "From the main session, which put your question to the owner. The owner's answer is in their own words below; the main session's note is its own words, not theirs.",
        "Your question:",
        answers,
        ...owner,
        "The main session's note, every line starting with \"| \":",
        note,
      ].join("\n"));
    }
    return formatTomoEvent("subsession-relay", [
      "From the main session, while you waited on your question to the owner. No message of the owner's came with it: this is the main session's own note, not the owner's answer. If you still need their decision, ask again with task_ask.",
      "Your question:",
      answers,
      "The main session's note, every line starting with \"| \":",
      note,
    ].join("\n"));
  }
  if (owner.length > 0) {
    return formatTomoEvent("subsession-relay", [
      ...owner,
      "From the main session, passing them on (its note is its own words, not the owner's; every line starts with \"| \"):",
      note,
    ].join("\n"));
  }
  return formatTomoEvent("subsession-relay", [
    "From the main session (a colleague passing something on; not the owner's own words or approval; every line starts with \"| \"):",
    note,
  ].join("\n"));
}

function quoteLines(text: string, mark: string): string {
  return text.split(/\r\n|\r|\n/).map((line) => `${mark}${line}`).join("\n");
}

/**
 * A message the owner sent this task (`/s <id> …` or a reply to one of its
 * messages): their own words, with any files they attached by path.
 */
export function formatOwnerMessageEvent(text: string, files: string[] = []): string {
  const lines = ["The owner wrote to you (their own words). Answer with task_reply:", text];
  if (files.length > 0) lines.push("", "Files they attached:", ...files.map((f) => `- ${f}`));
  return formatTomoEvent("subsession-owner-message", lines.join("\n"));
}

/** After a /compact: the task record, which outranks the summary. */
export function formatPostCompactReminder(record: SubsessionRecord): string {
  return formatTomoEvent("subsession-record", [
    "Your context was just compacted. This is the task record; trust it over your memory of earlier turns.",
    "",
    recordReminder(record),
  ].join("\n"), { name: record.id });
}

/** The instructions sent with `/compact`. */
export function compactInstructions(record: SubsessionRecord): string {
  return [
    `Keep: the goal of task ${record.id} (${record.title}), what is done, the next step,`,
    "every side effect that already happened (commits, pushes, PRs, messages sent, files written),",
    "open questions to the owner, and anything the owner said that changes the plan.",
    "Drop tool output that is no longer needed.",
  ].join(" ");
}

function recordReminder(record: SubsessionRecord): string {
  const lines = [`Task: ${record.title}`, `Status: ${record.status}`];
  if (record.plan?.length) {
    lines.push("Plan (steps still ahead):");
    for (const step of record.plan) lines.push(`- [${step.status === "in_progress" ? "in progress" : "not started"}] ${step.text}`);
  }
  const doneSteps = (record.doneSteps ?? []).slice(-5);
  if (doneSteps.length > 0) {
    lines.push("Steps you already filed as done (newest last; do not file them again):");
    for (const d of doneSteps) lines.push(`- ${d.text}${d.result ? `: ${d.result}` : ""}`);
  }
  const updates = (record.updates ?? []).slice(-5);
  if (updates.length > 0) {
    lines.push("Decisions and updates you recorded (newest last):");
    for (const u of updates) lines.push(`- ${u.kind === "plan" ? `Plan changed: ${u.text}` : u.text}`);
  }
  if (record.checkpoint) lines.push("Checkpoint:", record.checkpoint);
  const sent = record.sent.slice(-5);
  if (sent.length > 0) {
    lines.push("Messages you sent the owner (newest last):");
    for (const m of sent) lines.push(`- ${new Date(m.at).toISOString()}${m.via === "main" ? " (handed to the main session)" : m.via === "panel" ? " (in the web task panel)" : ""}: ${truncate(m.text, 300)}`);
  }
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One mirrored line is cut at this length (task_status shows what the task sent in full). */
export const MIRROR_ENTRY_MAX = 1500;

/**
 * The owning session's view of what the owner and its tasks said to each
 * other (config `subsessions.mirror`). The same text serves both modes: the
 * prefix of a silent "turn" wake, or of the session's next turn ("note").
 * Attachment paths stay out (a MEDIA: line becomes "[attachment]"; the
 * owner's files are only counted).
 */
export function formatMirrorNote(tasks: Array<{ record: SubsessionRecord; entries: SubsessionConversationEntry[] }>): string {
  const lines = [
    "The owner talked with your sub-sessions directly; this is a record of that conversation, for you to know about. The owner has already seen it, so don't repeat it back, and don't answer it on the task's behalf.",
    "If it affects other work (another task, a decision you made), tell the task with task_message, or raise it the next time the owner talks to you.",
  ];
  for (const { record, entries } of tasks) {
    lines.push("", `${record.id} · "${record.title}" (now ${statusPhrase(record)}):`);
    for (const entry of entries) {
      const who = entry.from === "owner" ? "owner" : `${record.id} (${entry.kind === "fallback" ? "its own text, sent for it" : entry.kind})`;
      const files = entry.files ? ` [${entry.files} file${entry.files === 1 ? "" : "s"} attached]` : "";
      lines.push(`- ${who}: ${mirrorText(entry.text)}${files}`);
    }
  }
  return formatTomoEvent("subsession-activity", lines.join("\n"), { name: "mirror" });
}

function mirrorText(text: string): string {
  const clean = text.replace(/MEDIA:\S+/g, "[attachment]").trim();
  const cut = clean.length <= MIRROR_ENTRY_MAX ? clean : `${clean.slice(0, MIRROR_ENTRY_MAX - 1)}… (cut)`;
  // Continuation lines indented under their bullet.
  return cut.replace(/\n/g, "\n  ");
}

function statusPhrase(record: SubsessionRecord): string {
  if (record.status === "waiting") return record.waitingOn === "owner" ? "waiting for the owner" : "waiting on something external";
  return record.status === "active" ? "working" : record.status;
}
