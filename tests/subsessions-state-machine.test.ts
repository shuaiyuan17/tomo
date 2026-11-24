import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextStatus, SUBSESSION_EVENTS, IllegalTransitionError, type SubsessionEvent, type TransitionResult } from "../src/agent/subsessions/state-machine.js";
import { SubsessionStore } from "../src/agent/subsessions/store.js";
import { SUBSESSION_STATUSES, type SubsessionStatus, type WaitingOn } from "../src/agent/subsessions/types.js";

/**
 * The whole table, written out by hand: every (state, event) pair. A change
 * to the state machine has to change this table too, on purpose.
 *
 * `-` illegal, `=` legal and leaves the state as it is, otherwise the target.
 */
type State = "queued" | "active" | "waiting(owner)" | "waiting(external)" | "finished" | "cancelled" | "failed" | "archived";
const STATES: State[] = ["queued", "active", "waiting(owner)", "waiting(external)", "finished", "cancelled", "failed", "archived"];

const EXPECTED: Record<SubsessionEvent, Record<State, string>> = {
  //                  queued       active               waiting(owner)  waiting(external)  finished     cancelled    failed     archived
  start:             { queued: "active", active: "-", "waiting(owner)": "-", "waiting(external)": "-", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  wait_external:     { queued: "-", active: "waiting(external)", "waiting(owner)": "-", "waiting(external)": "-", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  stuck:             { queued: "-", active: "waiting(owner)", "waiting(owner)": "-", "waiting(external)": "-", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  ask:               { queued: "-", active: "waiting(owner)", "waiting(owner)": "waiting(owner)", "waiting(external)": "waiting(owner)", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  finish:            { queued: "-", active: "finished", "waiting(owner)": "finished", "waiting(external)": "finished", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  reopen:            { queued: "-", active: "-", "waiting(owner)": "-", "waiting(external)": "-", finished: "active", cancelled: "-", failed: "-", archived: "-" },
  owner_message:     { queued: "=", active: "=", "waiting(owner)": "active", "waiting(external)": "active", finished: "=", cancelled: "-", failed: "-", archived: "-" },
  relay:             { queued: "=", active: "=", "waiting(owner)": "active", "waiting(external)": "active", finished: "=", cancelled: "-", failed: "-", archived: "-" },
  cron_wake:         { queued: "=", active: "=", "waiting(owner)": "-", "waiting(external)": "queued", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  background_report: { queued: "=", active: "=", "waiting(owner)": "=", "waiting(external)": "queued", finished: "=", cancelled: "-", failed: "-", archived: "-" },
  restart:           { queued: "-", active: "queued", "waiting(owner)": "-", "waiting(external)": "-", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  self_restart:      { queued: "-", active: "waiting(owner)", "waiting(owner)": "-", "waiting(external)": "-", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  recover_cut_short: { queued: "-", active: "-", "waiting(owner)": "queued", "waiting(external)": "queued", finished: "-", cancelled: "-", failed: "-", archived: "-" },
  cancel:            { queued: "cancelled", active: "cancelled", "waiting(owner)": "cancelled", "waiting(external)": "cancelled", finished: "cancelled", cancelled: "=", failed: "-", archived: "-" },
  fail:              { queued: "failed", active: "failed", "waiting(owner)": "failed", "waiting(external)": "failed", finished: "failed", cancelled: "-", failed: "-", archived: "-" },
  archive:           { queued: "-", active: "-", "waiting(owner)": "-", "waiting(external)": "-", finished: "archived", cancelled: "-", failed: "-", archived: "-" },
};

function split(state: State): { status: SubsessionStatus; waitingOn?: WaitingOn } {
  if (state === "waiting(owner)") return { status: "waiting", waitingOn: "owner" };
  if (state === "waiting(external)") return { status: "waiting", waitingOn: "external" };
  return { status: state };
}

function render(result: TransitionResult): string {
  if (result === null) return "-";
  if (result === "same") return "=";
  return result.status === "waiting" ? `waiting(${result.waitingOn})` : result.status;
}

describe("sub-session state machine: the whole table", () => {
  it("covers every status and every event", () => {
    expect(new Set(STATES.map((s) => split(s).status))).toEqual(new Set(SUBSESSION_STATUSES));
    expect(Object.keys(EXPECTED).sort()).toEqual([...SUBSESSION_EVENTS].sort());
  });

  for (const event of SUBSESSION_EVENTS) {
    for (const state of STATES) {
      it(`${state} + ${event} → ${EXPECTED[event][state]}`, () => {
        const { status, waitingOn } = split(state);
        expect(render(nextStatus(status, waitingOn, event))).toBe(EXPECTED[event][state]);
      });
    }
  }

  it("never leaves a terminal status except by the legal no-op cancel", () => {
    for (const terminal of ["cancelled", "failed", "archived"] as const) {
      for (const event of SUBSESSION_EVENTS) {
        const result = nextStatus(terminal, undefined, event);
        if (terminal === "cancelled" && event === "cancel") expect(result).toBe("same");
        else expect(result).toBeNull();
      }
    }
  });

  it("only the scheduler's start makes a queued task active", () => {
    for (const event of SUBSESSION_EVENTS) {
      const result = nextStatus("queued", undefined, event);
      if (result && result !== "same" && result.status === "active") expect(event).toBe("start");
    }
  });

  it("nothing autonomous wakes a task waiting for the owner", () => {
    for (const event of ["cron_wake", "background_report", "start", "restart"] as const) {
      const result = nextStatus("waiting", "owner", event);
      expect(result === null || result === "same").toBe(true);
    }
  });
});

describe("sub-session store: transitions go through the table", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  const make = (strict: boolean) => {
    dir = mkdtempSync(join(tmpdir(), "tomo-subsm-"));
    return new SubsessionStore(join(dir, "subsessions.json"), { strictTransitions: strict });
  };

  it("throws on an illegal transition when strict", () => {
    const store = make(true);
    const t = store.create({ parentKey: "dm:owner", title: "x", brief: "y" });
    expect(() => store.transition(t.id, "finish")).toThrow(IllegalTransitionError);
    expect(store.get(t.id)?.status).toBe("queued");
  });

  it("refuses and logs an illegal transition otherwise, changing nothing", () => {
    const store = make(false);
    const t = store.create({ parentKey: "dm:owner", title: "x", brief: "y" });
    const outcome = store.transition(t.id, "finish");
    expect(outcome.ok).toBe(false);
    expect(outcome.from).toBe("queued");
    expect(store.get(t.id)?.transitions).toHaveLength(1);
  });

  it("compare-and-set: expectFrom refuses when the status moved", () => {
    const store = make(true);
    const t = store.create({ parentKey: "dm:owner", title: "x", brief: "y" });
    expect(store.transition(t.id, "start", { expectFrom: ["queued"] }).ok).toBe(true);
    expect(store.transition(t.id, "start", { expectFrom: ["queued"] }).ok).toBe(false);
  });

  it("walks a whole life and logs each change", () => {
    const store = make(true);
    const t = store.create({ parentKey: "dm:owner", title: "x", brief: "y" });
    store.transition(t.id, "start");
    store.transition(t.id, "wait_external", { reason: "CI" });
    expect(store.get(t.id)).toMatchObject({ status: "waiting", waitingOn: "external", waitingReason: "CI" });
    store.transition(t.id, "cron_wake");
    store.transition(t.id, "start");
    store.transition(t.id, "finish");
    store.transition(t.id, "archive");
    const done = store.get(t.id)!;
    expect(done.status).toBe("archived");
    expect(done.waitingOn).toBeUndefined();
    expect(done.transitions.map((x) => x.to)).toEqual(["queued", "active", "waiting", "queued", "active", "finished", "archived"]);
  });

  it("cancel is idempotent", () => {
    const store = make(true);
    const t = store.create({ parentKey: "dm:owner", title: "x", brief: "y" });
    expect(store.transition(t.id, "cancel")).toMatchObject({ ok: true, changed: true });
    expect(store.transition(t.id, "cancel")).toMatchObject({ ok: true, changed: false });
    expect(store.get(t.id)?.transitions).toHaveLength(2);
  });
});
