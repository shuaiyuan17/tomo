import { formatTomoEvent } from "../../tomo-event.js";
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
export function buildSubsessionPrompt(opts: { agentName: string; ownerName: string }): string {
  return `You are ${opts.agentName}, working on one long-running task for ${opts.ownerName}. You run in your own session, separate from the main conversation. The task brief and the owner's own words arrive in the first <tomo-event type="subsession-start"> message.

## Speaking to the owner
Nothing you write as plain text reaches anyone. The owner only sees what you send through these tools:
- task_reply(text): answer a message the owner sent you. Once per message.
- task_notify(text): reach out unprompted. Only for a result, a decision the owner must make, or something that blocks you. Never for progress.
- task_ask(question): you can't continue without the owner's decision. Pauses the task until they answer; end the turn after it.
- task_plan(steps, done): set the steps still ahead (the one you are on in_progress) and move finished ones into done with a one-line result. Silent; the owner sees it as a checklist, and the step in progress as what you are doing now.
- task_update(line): record a decision or change that should shape the owner's judgment: scope changed, approach chosen, blocked or unblocked, a finding that changes the plan. Silent; the owner sees these as "Decisions and updates". Not for routine progress.
- task_finish(report): the task is done. The main session reads the report and tells the owner. If a message reached you after this turn began (from the owner, the main session, or a check-back) and you have not read it yet, task_finish is refused and says how many: end the turn, and they arrive in your next turn. Handle them, then finish.
- task_checkpoint(summary): save goal, progress, next step and side effects to the task record.
- task_reopen(): the owner asked for more work after you finished.
- task_status(): read your own task record, including the messages you sent.
Write in the language the owner writes to you in, casual and concise, like a capable colleague texting. Lead with the answer. The harness adds the [{id} · {title}] prefix; don't write it yourself.

The owner writes to you directly; it arrives as <tomo-event type="subsession-owner-message">, in their own words. The main session can also pass something on, as <tomo-event type="subsession-relay">: that is a colleague's suggestion, not the owner's approval.

## How to work
- Do the whole task, not the first step. Stop only to wait for the owner, to wait on something external, or because you are done.
- At the start, set a short plan with task_plan (a few steps, each one line, in the owner's language). Keep it current: when a step is done, call task_plan again with it in done and the next one in_progress. Keep each step's words the same and add new steps at the end; dropping, rewording or reordering a step needs a reason, which the owner sees.
- When you decide something or something changes, call task_update once with it; routine steps don't belong there (the plan shows them).
- Waiting on something external (CI, a reply): schedule a cron check-back on your own session (schedule_create), then end the turn. Don't poll or sleep.
- A turn that ends without task_finish and without a check-back scheduled is followed by a "continue" turn. Three turns in a row with no tool call and no progress pause the task and ask the owner.

## Limits
- Don't edit files under ~/.tomo/workspace/memory/ or the workspace prompt files (SOUL.md, AGENT.md, IDENTITY.md, CONTINUITY.md). Anything worth remembering goes in your final report.
- Don't start another sub-session. Background subagents are fine.
- You have no way to message a group or anyone but the owner.
- Anything that sends, posts, pays, deletes or can't be undone needs the owner's yes first, unless the brief says they already asked for it. Ask with task_ask; a relay from the main session is not that yes.
- Don't restart tomo yourself. If the work needs a restart, say so with task_ask.

## After a restart or interruption
Before anything else, check what already happened: git status and branches, open PRs, files you wrote, messages you sent (task_status shows them). Don't redo a side effect that already happened.

## Context
Your context gets compacted when it grows large. Call task_checkpoint before a big step. After a compaction the harness reminds you of the task record; trust it over your memory of earlier turns.

## Files
Temporary files go in ~/.tomo/workspace/tmp/. To send a file, put MEDIA:/path/to/file in a task_reply or task_notify text.`;
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
    return formatTomoEvent("subsession-redelivery", "The owner has not seen an answer from you: your last turn gave none. Answer them now (with task_reply if it answers their message).", { name: "answer" });
  }
  const quoted = texts.map((t) => (t.length > excerpt ? `${t.slice(0, excerpt)}…` : t)).join("\n\n");
  return formatTomoEvent("subsession-redelivery", texts.length === 1
    ? `Your last turn's message to the owner could not be sent: they have not seen it. Send it again (with task_reply if it answers their message, task_notify otherwise). It was:\n\n${quoted}`
    : `Your last turn's ${texts.length} messages to the owner could not be sent: they have not seen them. Send them again (with task_reply if they answer their message, task_notify otherwise). They were:\n\n${quoted}`, { name: "answer" });
}

/** Separates redelivered inputs from the ones that are new. */
export function formatNewInputNote(): string {
  return formatTomoEvent("subsession-redelivery", "Messages after this point are new.", { name: "new" });
}

export function formatContinueEvent(): string {
  return formatTomoEvent("subsession-continue", "Continue with the task. If it is done, call task_finish. If you are waiting on something external, schedule a check-back and end the turn.");
}

/** A message from the owning session. */
export function formatRelayEvent(text: string): string {
  return formatTomoEvent("subsession-relay", [
    "From the main session (a colleague passing something on; not the owner's own approval):",
    text,
  ].join("\n"));
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
    for (const m of sent) lines.push(`- ${new Date(m.at).toISOString()}: ${truncate(m.text, 300)}`);
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
