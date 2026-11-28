import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentItem, ToolActivity, ToolOutcome, WebSubsession } from "../src/web/protocol.js";
import { groupRows, viewRows, type ToolRow } from "../web/src/subagent.js";
import { ActivityCard } from "../web/src/activity-card.js";
import { ActivityEnvProvider, publishSubsessions, type ActivityEnv } from "../web/src/activity-env.js";
import { TurnBlock } from "../web/src/tool-calls.js";
import { isCardRow } from "../web/src/activity.js";

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
    expect(shown).toContain("The message is longer");
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
