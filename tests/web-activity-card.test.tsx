import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentItem, ToolActivity, ToolOutcome, WebSubsession } from "../src/web/protocol.js";
import { groupRows, viewRows, type ToolRow } from "../web/src/subagent.js";
import { ActivityCard } from "../web/src/activity-card.js";
import { ActivityEnvProvider, publishSubsessions, type ActivityEnv } from "../web/src/activity-env.js";
import { TurnBlock } from "../web/src/tool-calls.js";
import { isCardRow } from "../web/src/activity.js";
import { i18n } from "../web/src/i18n/index.js";

const I = (tool: string) => `mcp__tomo-internal__${tool}`;
let n = 0;
const call = (activity: ToolActivity | undefined, result?: { outcome?: ToolOutcome; isError?: boolean; reason?: string; output?: string }, name?: string): SubagentItem[] => {
  const id = `toolu_${++n}abcdefghijklmnop`;
  const tool = name ?? I(activity?.kind ?? "task_spawn");
  return [{ kind: "tool", id: `${n}:0`, toolUseId: id, name: tool, summary: `${tool}: {"raw":true}`, input: '{"raw":true}', inputTruncated: false, ts: 1_000,
    ...(activity ? { activity } : {}) },
  ...(result ? [{ kind: "result" as const, id: `${n}:1`, toolUseId: id, output: result.output ?? "ok", truncated: false, isError: result.isError === true, ts: 3_000,
    ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.reason ? { reason: result.reason } : {}) }] : [])];
};
const row = (items: SubagentItem[]) => viewRows(items)[0] as ToolRow;
const card = (r: ToolRow, opts: { running?: boolean; rawOpen?: boolean; env?: ActivityEnv } = {}) => {
  const el = createElement(ActivityCard, { rows: [r], running: opts.running ?? false, rawOpen: opts.rawOpen ?? false, onRawOpen: () => undefined });
  return renderToStaticMarkup(opts.env ? createElement(ActivityEnvProvider, { value: opts.env }, el) : el);
};
const task = (over: Partial<WebSubsession> = {}): WebSubsession =>
  ({ id: "s12", title: "Activity cards", status: "active", working: true, createdAt: 0, lastActivityAt: 0, ...over }) as WebSubsession;

const spawn: ToolActivity = { kind: "task_spawn", title: "Activity cards", brief: "Build the cards", model: "claude-opus-5-5" };
const note: ToolActivity = { kind: "task_message", id: "s12", text: "The owner picked A.", withOwner: true };
const cancel: ToolActivity = { kind: "task_cancel", id: "s12", reason: "superseded" };
const send: ToolActivity = { kind: "send_message", target: "telegram:-2", targetId: "w-club", mode: "direct", text: "Poll goes out Friday.", chars: 21 };

afterEach(() => publishSubsessions([], false));

describe("task_spawn card", () => {
  it("done: title, id, brief, and the task's state NOW in the footer, with a way to it", () => {
    publishSubsessions([task({ status: "waiting", waitingOn: "owner" })]);
    const shown = card(row(call(spawn, { outcome: { id: "s12", status: "active" } })), { env: { sessions: [], openTask: () => undefined } });
    expect(shown).toContain('data-activity-card="task_spawn"');
    expect(shown).toContain('data-state="done"');
    expect(shown).toContain("Started a task");
    expect(shown).toContain("Activity cards");
    expect(shown).toContain("Build the cards");
    expect(shown).toContain("Waiting for you");
    expect(shown).not.toContain("Queued");
    expect(shown).toContain("Open task");
    expect(shown).not.toContain("mcp__tomo-internal__");
  });
  it("a task no longer listed says so; before the list loads it says nothing", () => {
    publishSubsessions([]);
    expect(card(row(call(spawn, { outcome: { id: "s12" } })))).toContain("No longer in the task list");
    publishSubsessions([], false);
    expect(card(row(call(spawn, { outcome: { id: "s12" } })))).not.toContain("No longer in the task list");
  });
  it("without a rail (a subagent transcript) there is no Open task button", () => {
    publishSubsessions([task()]);
    expect(card(row(call(spawn, { outcome: { id: "s12" } })))).not.toContain("Open task");
  });
  it("running: shimmers with the running mark, no footer", () => {
    const shown = card(row(call(spawn)), { running: true });
    expect(shown).toContain('data-state="running"');
    expect(shown).toContain("Starting a task");
    expect(shown).toContain('data-slot="running-mark"');
    expect(shown).not.toContain("Open task");
  });
  it("failed: the reason in the tool's own words, outlined in destructive", () => {
    const shown = card(row(call(spawn, { isError: true, reason: "Too many open tasks (8).", output: "task_spawn failed: Too many open tasks (8)." })));
    expect(shown).toContain('data-state="error"');
    expect(shown).toContain("Couldn&#x27;t start the task");
    expect(shown).toContain("Too many open tasks (8).");
    expect(shown).toContain("border-destructive");
  });
});

describe("task_message card", () => {
  it("done: the note quoted, with the owner's message flag", () => {
    const shown = card(row(call(note, { outcome: { delivery: "delivered" } })));
    expect(shown).toContain("Passed a note to");
    expect(shown).toContain("The owner picked A.");
    expect(shown).toContain("With your own message attached");
  });
  it("held: says so, and the tool's reason in warn", () => {
    const shown = card(row(call(note, { outcome: { delivery: "held", noop: "s12 still waits on the owner" } })));
    expect(shown).toContain("held");
    expect(shown).toMatch(/text-warn[^>]*>s12 still waits on the owner/);
  });
  it("running and failed", () => {
    expect(card(row(call(note)), { running: true })).toContain("Passing a note to");
    const failed = card(row(call(note, { isError: true, reason: "No task s12." })));
    expect(failed).toContain("Couldn&#x27;t pass the note");
    expect(failed).toContain("No task s12.");
    expect(failed).not.toContain("The owner picked A.");
  });
  it("a long note is clamped with Show all", () => {
    const long = card(row(call({ ...note, text: "line\n".repeat(10) } as ToolActivity, { outcome: {} })));
    expect(long).toContain("line-clamp-3");
    expect(long).toContain("Show all");
    expect(card(row(call(note, { outcome: {} })))).not.toContain("Show all");
  });
});

describe("task_cancel card", () => {
  it("done, running, failed, and a no-op in warn", () => {
    publishSubsessions([task({ status: "cancelled", working: false })]);
    const done = card(row(call(cancel, { outcome: {} })));
    expect(done).toContain("Cancelled a task");
    expect(done).toContain("Activity cards");
    expect(done).toContain("Reason: superseded");
    expect(card(row(call(cancel)), { running: true })).toContain("Cancelling a task");
    expect(card(row(call(cancel, { isError: true, reason: "No such task." })))).toContain("No such task.");
    expect(card(row(call(cancel, { outcome: { noop: "s12 had already finished." } })))).toMatch(/text-warn[^>]*>s12 had already finished/);
  });
});

describe("send_message card", () => {
  const env: ActivityEnv = { sessions: [{ id: "w-club", title: "Book club" } as ActivityEnv["sessions"][number]], sessionId: "w-owner", ownerConversation: true };
  it("done: names the conversation by its title, the channel, and the message", () => {
    const shown = card(row(call(send, { outcome: {} })), { env });
    expect(shown).toContain("Sent to <b");
    expect(shown).toContain("Book club");
    expect(shown).toContain("Telegram");
    expect(shown).toContain("Poll goes out Friday.");
  });
  it("a direct message to the conversation on screen is a one-line card (the message is the next bubble)", () => {
    const shown = card(row(call({ ...send, target: "dm:owner", targetId: undefined, toOwner: true } as ToolActivity, { outcome: {} })), { env });
    expect(shown).toContain("Sent to this conversation");
    expect(shown).not.toContain("Poll goes out Friday.");
  });
  it("delegate: says what it asked, not that it sent these words", () => {
    const shown = card(row(call({ ...send, mode: "delegate" } as ToolActivity, { outcome: {} })), { env });
    expect(shown).toContain("to write one");
    expect(shown).toContain("this is what it was asked");
  });
  it("running and failed", () => {
    expect(card(row(call(send)), { running: true, env })).toContain("Sending to");
    const failed = card(row(call(send, { isError: true, reason: "Unknown target telegram:-2." })), { env });
    expect(failed).toContain("Couldn&#x27;t send to");
    expect(failed).toContain("Unknown target telegram:-2.");
  });
  it("long text: clamped at six lines, and a truncated message says the raw data has more", () => {
    const shown = card(row(call({ ...send, text: "x\n".repeat(20), textTruncated: true } as ToolActivity, { outcome: {} })), { env });
    expect(shown).toContain("line-clamp-6");
    expect(shown).not.toContain("Longer than shown here");
    const short = card(row(call({ ...send, text: "short", textTruncated: true } as ToolActivity, { outcome: {} })), { env });
    expect(short).toContain("Longer than shown here");
  });
});

describe("the raw-data button", () => {
  it("closed: only the button; open: the call's full name, id, input and output, and what the data is", () => {
    const r = row(call(spawn, { outcome: { id: "s12" }, output: "Started s12 (active)." }));
    const closed = card(r);
    expect(closed).toContain('aria-label="Raw data"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('data-slot="activity-raw"');
    const open = card(r, { rawOpen: true });
    expect(open).toContain('data-slot="activity-raw"');
    expect(open).toContain("mcp__tomo-internal__task_spawn");
    expect(open).toContain("Started s12 (active).");
    expect(open).toContain("clipped at 4,000 characters");
    expect(open).toContain("Copy JSON");
  });
  it("its open state is kept by the call id in the chat's choices", () => {
    const r = row(call(spawn, { outcome: { id: "s12" } }));
    const block = { kind: "card" as const, key: `card:${r.toolUseId}`, rows: [r] };
    const shown = renderToStaticMarkup(createElement(TurnBlock, { block, running: false, choices: { [`raw:${r.toolUseId}`]: true }, onChoice: () => undefined }));
    expect(shown).toContain('data-slot="activity-raw"');
  });
});

describe("cards in the turn", () => {
  it("a card splits a run of lines; it is never folded into a group", () => {
    const items = [...call({ kind: "task_status", id: "s1" }, { outcome: {} }), ...call({ kind: "task_status", id: "s2" }, { outcome: {} }),
      ...call(spawn, { outcome: { id: "s3" } }), ...call({ kind: "task_status", id: "s3" }, { outcome: {} })];
    expect(groupRows(viewRows(items)).map((b) => b.kind)).toEqual(["group", "card", "tool"]);
  });
  it("only the four kinds with an activity are cards; others, unknown ones and a subagent's (no activity) stay lines", () => {
    expect(isCardRow(row(call(spawn, { outcome: {} })))).toBe(true);
    expect(isCardRow(row(call({ kind: "task_status", id: "s1" }, { outcome: {} })))).toBe(false);
    expect(isCardRow(row(call(undefined, { outcome: {} })))).toBe(false);
    expect(isCardRow(row(call({ kind: "memory_teleport" } as unknown as ToolActivity, { outcome: {} })))).toBe(false);
  });
  it("an unknown kind renders nothing as a card (the caller keeps the line)", () => {
    expect(card(row(call({ kind: "task_status", id: "s1" }, { outcome: {} })))).toBe("");
  });
});

describe("no result after the turn ended", () => {
  it("claims neither success nor failure", () => {
    const shown = card(row(call(cancel)));
    expect(shown).toContain('data-state="unknown"');
    expect(shown).not.toContain("Cancelled a task");
    expect(shown).toContain("may or may not have happened");
    expect(shown).not.toContain("shimmer");
    expect(card(row(call(note)))).not.toContain("With your own message attached");
    expect(card(row(call(note)), { running: true })).not.toContain("With your own message attached");
    const sent = card(row(call(send)), { env: { sessions: [] } });
    expect(sent).not.toMatch(/Sent to/);
  });
});

describe("a send to the conversation on screen with a problem noted", () => {
  it("keeps the full card so the note shows", () => {
    const env: ActivityEnv = { sessions: [], ownerConversation: true };
    const shown = card(row(call({ ...send, target: "dm:owner", targetId: undefined, toOwner: true } as ToolActivity, { outcome: { note: "chart.png could not be attached." } })), { env });
    expect(shown).not.toContain("Sent to this conversation");
    expect(shown).toMatch(/text-warn[^>]*>chart.png could not be attached/);
  });
});

describe("truncation and attachments", () => {
  it("a note or brief the server clipped says the raw data has more", () => {
    expect(card(row(call({ ...note, textTruncated: true } as ToolActivity, { outcome: {} })))).toContain("Longer than shown here");
    expect(card(row(call({ ...spawn, briefTruncated: true } as ToolActivity, { outcome: {} })))).toContain("Longer than shown here");
    expect(card(row(call(note, { outcome: {} })))).not.toContain("Longer than shown here");
  });
  it("stickers are a chip; the raw panel keeps the full call id in the page (CSS truncates it) for manual copy", () => {
    expect(card(row(call({ ...send, stickers: 2 } as ToolActivity, { outcome: {} })), { env: { sessions: [] } })).toContain("2 stickers");
    const r = row(call(spawn, { outcome: {} }));
    expect(card(r, { rawOpen: true })).toContain(`>${r.toolUseId}</span>`);
  });
});

describe("to-do cards", () => {
  const add: ToolActivity = { kind: "todo_add", title: "Review the design", next: "Read s12's report", waitingOn: "owner", reviewIn: "3d" };
  const done: ToolActivity = { kind: "todo_resolve", id: "t-40", action: "done", evidence: "PR 689" };
  const snooze: ToolActivity = { kind: "todo_resolve", id: "t-39", action: "snooze", until: "1w", reason: "waiting on CI" };
  const cardOf = (items: SubagentItem[], running = false) => {
    const blocks = groupRows(viewRows(items));
    const block = blocks.find((b) => b.kind === "card");
    return block?.kind === "card" ? renderToStaticMarkup(createElement(ActivityCard, { rows: block.rows, running, rawOpen: false, onRawOpen: () => undefined })) : "";
  };
  it("one add: its head, the title, next step, who it waits on and when it is reviewed", () => {
    const shown = card(row(call(add, { outcome: { id: "t-41", title: "Review the design", review: "Nov 17" } })));
    expect(shown).toContain('data-activity-card="todo_add"');
    expect(shown).toContain("Added a to-do");
    expect(shown).toContain("Review the design");
    expect(shown).toContain("t-41");
    expect(shown).toContain("next: Read s12&#x27;s report · waiting on you · review Nov 17");
  });
  it("running and failed", () => {
    expect(card(row(call(add)), { running: true })).toContain("Adding a to-do");
    const failed = card(row(call(add, { isError: true, reason: "\"2026-11-13\" is not in the future." })));
    expect(failed).toContain("Couldn&#x27;t add the to-do");
    expect(failed).toContain("Not added: &quot;2026-11-13&quot; is not in the future.");
  });
  it("a resolve: per action head; done and dropped are struck through; a snooze says until when and which time", () => {
    const closed = card(row(call(done, { outcome: { id: "t-40", title: "Ship part 1" } })));
    expect(closed).toContain("Closed a to-do");
    expect(closed).toContain("line-through");
    expect(closed).toContain("PR 689");
    const snoozed = card(row(call(snooze, { outcome: { id: "t-39", title: "Merge", review: "Dec 4", snoozes: 2, maxSnoozes: 3 } })));
    expect(snoozed).toContain("Snoozed a to-do");
    expect(snoozed).toContain("until Dec 4 · snoozed 2 of 3 · waiting on CI");
    expect(snoozed).not.toContain("line-through");
  });
  it("a resolve's printed next step is labelled in the reader's language", async () => {
    await i18n.changeLanguage("zh-Hans");
    try {
      expect(card(row(call(done, { outcome: { id: "t-40", title: "Ship · next: merge it" } })))).toContain("Ship · 下一步： merge it");
    } finally { await i18n.changeLanguage("en"); }
  });
  it("calls in a row merge into one card: a failed add, the retry, and closes; the head counts them", () => {
    const items = [...call(add, { isError: true, reason: "not in the future." }), ...call(add, { outcome: { id: "t-41" } }),
      ...call(done, { outcome: { id: "t-40" } }), ...call(done, { outcome: { id: "t-38" } })];
    const blocks = groupRows(viewRows(items));
    expect(blocks.map((b) => b.kind)).toEqual(["card"]);
    const shown = cardOf(items);
    expect(shown).toContain("To-dos · added 1, closed 2, and 1 failed");
    expect(shown).toContain("Not added: not in the future.");
    // Four lines: three shown, then "1 more".
    expect(shown.match(/data-todo-line=/g)).toHaveLength(3);
    expect(shown).toContain("1 more");
  });
  it("a merged call without a result is counted and marked, not shown as done", () => {
    const items = [...call(add, { outcome: { id: "t-41" } }), ...call(done)];
    const shown = cardOf(items);
    expect(shown).toContain("To-dos · added 1 and 1 without a result");
    expect(shown).toMatch(/data-todo-line="done" data-state="unknown"/);
    expect(shown).toContain("may or may not have happened");
  });
  it("each line tells a screen reader what was done to it", () => {
    const items = [...call(done, { outcome: { id: "t-40" } }), ...call(snooze, { outcome: { id: "t-39" } }), ...call(add, { isError: true, reason: "x" })];
    const shown = cardOf(items);
    expect(shown).toContain('<span class="sr-only">Close (done): </span>');
    expect(shown).toContain('<span class="sr-only">Snooze (done): </span>');
    expect(shown).toContain('<span class="sr-only">Add (failed): </span>');
    expect(cardOf(call(done), true)).toContain('<span class="sr-only">Close (in progress): </span>');
    expect(cardOf(call(done))).toContain('<span class="sr-only">Close (no result): </span>');
  });
  it("a line between them keeps them apart", () => {
    const items = [...call(add, { outcome: { id: "t-41" } }), ...call({ kind: "task_status", id: "s1" }, { outcome: {} }), ...call(done, { outcome: { id: "t-40" } })];
    expect(groupRows(viewRows(items)).map((b) => b.kind)).toEqual(["card", "tool", "card"]);
  });
});

describe("schedule card", () => {
  const create: ToolActivity = { kind: "schedule_create", name: "Design review", schedule: "2026-11-15T08:30", message: "Remind the owner to look at the design", once: true };
  it("done, once: name, its time in the reader's zone, the message, the job id and a link to it in Cron", () => {
    const shown = card(row(call(create, { outcome: { id: "c7f2a91e", lifecycle: "once", nextRunAt: Date.parse("2026-11-15T16:30:00Z") } })));
    expect(shown).toContain("Scheduled a task · once");
    expect(shown).toContain("Design review");
    expect(shown).toContain("Nov 15");
    expect(shown).toContain("Remind the owner");
    expect(shown).toContain('href="#study/cron/c7f2a91e"');
    expect(shown).toContain("Open in Cron");
  });
  it("recurring: the schedule in words, the next run, and where it delivers", () => {
    const env: ActivityEnv = { sessions: [{ id: "w-club", title: "Book club" } as ActivityEnv["sessions"][number]] };
    const shown = card(row(call({ ...create, schedule: "30 8 * * *", once: undefined, session: "telegram:-2", sessionId: "w-club" } as ToolActivity,
      { outcome: { id: "ab12", lifecycle: "recurring", cron: "30 8 * * *", nextRunAt: Date.parse("2026-11-16T16:30:00Z") } })), { env });
    expect(shown).toContain("Scheduled a task · recurring");
    expect(shown).toContain("30 8 * * *");
    expect(shown).toContain("Next: ");
    expect(shown).toContain("To Book club");
  });
  it("an interval is worded in the reader's language", () => {
    expect(card(row(call({ ...create, once: undefined } as ToolActivity, { outcome: { id: "ab", lifecycle: "recurring", everyMs: 7_200_000 } })))).toContain("every 2 hours");
    expect(card(row(call({ ...create, once: undefined } as ToolActivity, { outcome: { id: "ab", lifecycle: "recurring", everyMs: 90_000 } })))).toContain("every 90 seconds");
    // A date kept after it runs: lifecycle "recurring", but it fires once.
    expect(card(row(call({ ...create, once: undefined } as ToolActivity, { outcome: { id: "ab", lifecycle: "recurring", firesOnce: true, nextRunAt: 0 } })))).toContain("· once");
    // A cron job deleted after its first run (once: true) is once too.
    expect(card(row(call({ ...create, schedule: "30 8 * * *" } as ToolActivity, { outcome: { id: "ab", lifecycle: "once", cron: "30 8 * * *", nextRunAt: 0 } })))).toContain("· once");
  });
  it("running and failed", () => {
    expect(card(row(call(create)), { running: true })).toContain("Scheduling a task");
    const failed = card(row(call(create, { isError: true, reason: "invalid schedule \"x\"" })));
    expect(failed).toContain("Couldn&#x27;t schedule “Design review”");
    expect(failed).toContain("invalid schedule");
    expect(failed).not.toContain("Open in Cron");
  });
});

describe("permission and credential cards", () => {
  const perm: ToolActivity = { kind: "request_permission", path: "~/Documents/taxes", access: "read", reason: "To find last year's return" };
  const cred: ToolActivity = { kind: "request_credential", name: "github-token", purpose: "Open PRs" };
  it("permission: access, path, the reason quoted; the footer says only that it was sent (never the final answer)", () => {
    const shown = card(row(call(perm, { outcome: { status: "pending" } })));
    expect(shown).toContain("Asked you for access");
    expect(shown).toContain(">Read<");
    expect(shown).toContain("~/Documents/taxes");
    expect(shown).toContain("“To find last year&#x27;s return”");
    expect(shown).toContain("Request sent");
    expect(card(row(call(perm, { outcome: { status: "already_allowed" } })))).toContain("Already allowed");
    expect(card(row(call(perm)), { running: true })).toContain("Asking you for access");
    expect(card(row(call(perm, { isError: true, reason: "Not in a group." })))).toContain("Not in a group.");
  });
  it("credential: its name, purpose, where it was asked; never a value", () => {
    const shown = card(row(call(cred, { outcome: { status: "pending", channel: "telegram" } })));
    expect(shown).toContain("Asked you for a credential");
    expect(shown).toContain("github-token");
    expect(shown).toContain("Asked on Telegram");
    expect(card(row(call(cred)), { running: true })).toContain("Asking you for a credential");
    expect(card(row(call(cred, { isError: true, reason: "No channel to ask on." })))).toContain("No channel to ask on.");
  });
});

describe("a turn with more than six cards", () => {
  const sends = (n: number) => Array.from({ length: n }, (_, i) => call({ kind: "send_message", target: `telegram:-${i}`, mode: "direct", text: `m${i}`, chars: 2 }, { outcome: {} })).flat();
  it("shows six; the rest of the turn, cards and lines in order, folds under one row", () => {
    const items = [...sends(6), ...call({ kind: "task_status", id: "s1" }, { outcome: {} }), ...sends(3)];
    const blocks = groupRows(viewRows(items));
    expect(blocks.map((b) => b.kind)).toEqual(["card", "card", "card", "card", "card", "card", "tool", "more"]);
    const more = blocks.at(-1)!;
    expect(more.kind === "more" && more.cards).toBe(3);
    const html = renderToStaticMarkup(createElement(TurnBlock, { block: more as Extract<typeof more, { kind: "more" }>, running: false, choices: {}, onChoice: () => undefined }));
    expect(html).toContain("3 more activities");
  });
  it("six or fewer: nothing folds; a new turn (a message) starts the count again", () => {
    expect(groupRows(viewRows(sends(6))).map((b) => b.kind)).not.toContain("more");
    const items: SubagentItem[] = [...sends(4), { kind: "message", id: "m", text: "next", truncated: false }, ...sends(4)];
    expect(groupRows(viewRows(items)).map((b) => b.kind)).not.toContain("more");
  });
  it("open, it shows the folded cards", () => {
    const blocks = groupRows(viewRows(sends(7)));
    const more = blocks.at(-1)!;
    const html = renderToStaticMarkup(createElement(TurnBlock, { block: more as Extract<typeof more, { kind: "more" }>, running: false, choices: { [more.kind === "more" ? more.key : ""]: true }, onChoice: () => undefined }));
    expect(html).toContain('data-activity-card="send_message"');
  });
});
