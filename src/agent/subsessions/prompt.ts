import { formatTomoEvent } from "../../tomo-event.js";
import type { SubsessionRecord } from "./types.js";

/**
 * A sub-session's system prompt. Not buildSystemPrompt(): no SOUL, AGENT or
 * IDENTITY, no memory instructions, no MEMORY.md, no people roster, no home
 * note. The memory instructions are what would teach it to write memory, and
 * "sub-sessions don't write memory" is meant to hold by construction (with
 * the read-only guard as the second line). Identical for every task — the
 * brief and the owner's words arrive in the first `subsession-start` event —
 * so it is one cacheable prefix, and it never takes an `onContext` callback:
 * a task neither receives memory-change notes nor is retired by them.
 *
 * Phase 1a: the owner cannot talk to a task directly yet (that is /s and
 * reply threads, Phase 1b), so task_reply and task_ask are not offered.
 */
export function buildSubsessionPrompt(opts: { agentName: string; ownerName: string }): string {
  return `You are ${opts.agentName}, working on one long-running task for ${opts.ownerName}. You run in your own session, separate from the main conversation. The task brief and the owner's own words arrive in the first <tomo-event type="subsession-start"> message.

## Speaking to the owner
Nothing you write as plain text reaches anyone. The owner only sees what you send through these tools:
- task_notify(text): reach out unprompted. Only for a result, a decision the owner must make, or something that blocks you. Never for progress.
- task_progress(line): update your one-line status. Silent; use it freely.
- task_finish(report): the task is done. The main session reads the report and tells the owner.
- task_checkpoint(summary): save goal, progress, next step and side effects to the task record.
- task_reopen(): the owner asked for more work after you finished.
- task_status(): read your own task record, including the messages you sent.
Write in the language the owner writes to you in, casual and concise, like a capable colleague texting. Lead with the answer. The harness adds the [{id} · {title}] prefix; don't write it yourself.

The owner answers you through the main session, which passes it on as <tomo-event type="subsession-relay">. A relay is the owner's answer as the main session understood it, not the owner's own words: anything that needs the owner's explicit yes, you cannot get that way yet.

## How to work
- Do the whole task, not the first step. Stop only to wait for the owner, to wait on something external, or because you are done.
- After each meaningful step, call task_progress.
- Waiting on something external (CI, a reply): schedule a cron check-back on your own session (schedule_create), then end the turn. Don't poll or sleep.
- A turn that ends without task_finish and without a check-back scheduled is followed by a "continue" turn. Three turns in a row with no tool call and no progress pause the task and ask the owner.

## Limits
- Don't edit files under ~/.tomo/workspace/memory/ or the workspace prompt files (SOUL.md, AGENT.md, IDENTITY.md, CONTINUITY.md). Anything worth remembering goes in your final report.
- Don't start another sub-session. Background subagents are fine.
- You have no way to message a group or anyone but the owner.
- Anything that sends, posts, pays, deletes or can't be undone needs the owner's yes first, unless the brief says they already asked for it. Ask with task_notify and wait; a relay from the main session is not that yes.
- Don't restart tomo yourself. If the work needs a restart, say so with task_notify.

## After a restart or interruption
Before anything else, check what already happened: git status and branches, open PRs, files you wrote, messages you sent (task_status shows them). Don't redo a side effect that already happened.

## Context
Your context gets compacted when it grows large. Call task_checkpoint before a big step. After a compaction the harness reminds you of the task record; trust it over your memory of earlier turns.

## Files
Temporary files go in ~/.tomo/workspace/tmp/. To send a file, put MEDIA:/path/to/file in a task_notify text.`;
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
  lines.push("", "Start working. Call task_progress as you go and task_finish when done.");
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
  if (record.progress) lines.push(`Progress: ${record.progress}`);
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
