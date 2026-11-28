import { createHash } from "node:crypto";
import type { WatchEvent, WatchTask } from "../watch/protocol.js";
import { isDmSessionKey, isGroupSessionKey } from "../sessions/keys.js";
import { HOME_SUBSESSION_TYPE, type HomeStatus, type HomeSubagent, type HomeToolKind, type HomeTurnSource } from "./status.js";

/**
 * Turns the watch bus into HomeStatus: what Tomo is doing, for its home.
 * Pure: no I/O, no timers; the clock and the one privacy rule are passed in.
 * The subscriber (status-tracker.ts) feeds it events and publishes changes.
 *
 * Decisions, in one place:
 *
 * - TURNS. Every turn.start opens a turn for its session; turn.end (or a
 *   turn.requeue, which is a declined steer that never ran: turn.start went
 *   out but no turn.end will) closes the one with the same requestId, else
 *   the oldest open one of that session. `working` = any turn open anywhere.
 *   A turn still open after TURN_STALE_MS is dropped (a lost turn.end must
 *   not leave the room busy for ever).
 * - WHO (`by`). source user + a group key → group; source user + a dm: key
 *   (only the owner has one) → owner; cron → cron; continuity → heartbeat;
 *   anything else → other. With several turns open, the owner's wins; among
 *   the rest the most recently started. A summoned group's turn runs on the
 *   owner's dm: key and therefore reads as the owner's (the key is all the
 *   bus carries).
 * - TOOL. tool.start/tool.end carry a name, not a call id, so each session
 *   keeps a list of open calls; tool.end closes the newest open call of that
 *   name (or the newest call, for "?"); a session's calls all close with its
 *   turn. `tool` is the kind of the most recent open call in the `by`
 *   session, else in any session. Names map by toolKind() below.
 * - TASKS. From the `tasks` event (REPLACE per session). A subagent is a
 *   non-ambient `local_agent` task with no end status yet, foreground or
 *   background; `tasks` counts the other non-ambient, running, BACKGROUND
 *   tasks (shells, monitors, workflows). Ambient tasks (watchers) are left
 *   out of both. A subagent's `id` is a hash of its session and task id
 *   (stable for its life, reveals neither); `type` its subagent_type,
 *   lowercased and reduced to what a scene key can name; `task` its
 *   description, clipped, ONLY when `mayShowTask(sessionKey)` says the
 *   browser may already read that session (the Tasks panel's rule).
 * - SUB-SESSIONS. The owner's running sub-sessions (`context.subsessions`,
 *   read while building a status: the daemon decides which are running and
 *   which the browser may see) are visitors too, among the subagents by
 *   when they started: `type` "subsession", `task` the title (never the
 *   brief), `id` a hash of the task id.
 * - TROUBLE. retry → "retry" for that session until its turn ends or it
 *   makes progress (a tool starts); an API error → "error" until that
 *   session's next turn starts, at most TROUBLE_ERROR_MS; a rate limit
 *   rejected → "rate_limit" (account-wide) until a later allowed report,
 *   its resetsAt, or RATE_LIMIT_MS. Several at once: rate_limit, then
 *   error, then retry.
 * - COMPACTING. The SDK's own compaction (sdk signal `compacting`), or a
 *   shell call running `tomo lcm compact` (how Tomo compacts on purpose),
 *   until it ends, the session's compact_boundary arrives, the turn ends,
 *   or COMPACT_STALE_MS passes.
 * - cronAt: the last cron.fired. idleSince: when the last open turn closed
 *   (the reducer's creation time before any turn). nextJobAt and pet come
 *   from outside (the cron store, the pet store).
 */

export const TURN_STALE_MS = 2 * 60 * 60_000;
export const TROUBLE_ERROR_MS = 15 * 60_000;
export const RATE_LIMIT_MS = 60 * 60_000;
export const COMPACT_STALE_MS = 10 * 60_000;
/** Most subagents carried (a scene seats at most 12, the rest wait). */
export const MAX_HOME_SUBAGENTS = 32;
export const HOME_TASK_CHARS = 120;

const SHELL = new Set(["Bash", "BashOutput", "KillBash", "KillShell", "Monitor", "PowerShell"]);
const FILES = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "LS"]);
const SEARCH = new Set(["Grep", "Glob", "ToolSearch", "LSP"]);
const WEB = new Set(["WebFetch", "WebSearch"]);
const SUBAGENT = new Set(["Task", "Agent", "TaskOutput", "TaskStop", "SendMessage"]);

/**
 * The kind of a tool, by name. Built-ins by the sets above. MCP tools
 * (`mcp__<server>__<tool>`): Tomo's own recall_conversation is search; for
 * any other server the server and tool names are read for a hint (browser,
 * fetch, http… → web; search, find, query, grep → search; file, fs, read,
 * write… → files; shell, exec, terminal, command → shell); everything else,
 * and anything unknown, is other.
 */
export function toolKind(name: string): HomeToolKind {
  if (SHELL.has(name)) return "shell";
  if (FILES.has(name)) return "files";
  if (SEARCH.has(name)) return "search";
  if (WEB.has(name)) return "web";
  if (SUBAGENT.has(name)) return "subagent";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return "other";
  const [, server, tool] = mcp;
  if (server === "tomo-internal") return tool === "recall_conversation" ? "search" : "other";
  const words = `${server} ${tool}`.toLowerCase();
  if (/browser|playwright|puppeteer|chrome|fetch|http|web|url|navigate/.test(words)) return "web";
  if (/search|find|query|grep|lookup/.test(words)) return "search";
  if (/shell|exec|terminal|command|bash|run_/.test(words)) return "shell";
  if (/file|(^|[^a-z])fs([^a-z]|$)|read|write|edit|directory|folder/.test(words)) return "files";
  return "other";
}

/** A turn source and session key, as the home says who is working. */
export function turnSource(source: string, sessionKey: string): HomeTurnSource {
  if (source === "cron") return "cron";
  if (source === "continuity") return "heartbeat";
  if (source === "user") {
    if (isGroupSessionKey(sessionKey)) return "group";
    if (isDmSessionKey(sessionKey)) return "owner";
  }
  return "other";
}

interface OpenTurn { source: HomeTurnSource; requestId?: string; startedAt: number }
interface OpenTool { name: string; kind: HomeToolKind; startedAt: number; compact: boolean }
type Trouble = { kind: "retry" | "error"; at: number };

/** A running sub-session, as the home seats it. */
export interface HomeSubsession {
  /** The task's id ("s12"); only its hash leaves the reducer. */
  id: string;
  /** Its title, for the visitor's sign. Never the brief. */
  title: string;
  /** When it was started (ms epoch): its place among the visitors. */
  startedAt: number;
}

export interface ReducerContext {
  /** May the browser already read this session's task text (channels/web.ts taskRouter)? Asked only while building a status. */
  mayShowTask(sessionKey: string): boolean;
  /** The running sub-sessions the browser may already see (the Tasks rail's list). Asked only while building a status. */
  subsessions?(): readonly HomeSubsession[];
}

export class HomeStatusReducer {
  private turns = new Map<string, OpenTurn[]>();
  private tools = new Map<string, OpenTool[]>();
  private tasks = new Map<string, WatchTask[]>();
  private compacting = new Map<string, number>();
  private trouble = new Map<string, Trouble>();
  private rateLimited: { at: number; until?: number } | undefined;
  private cronAt: number | undefined;
  private idleSince: number;
  private nextJobAt: number | undefined;
  private pet: string | undefined;

  constructor(now: number) { this.idleSince = now; }

  setNextJobAt(at: number | undefined): void { this.nextJobAt = at; }
  setPet(mood: string | undefined): void { this.pet = mood; }

  apply(event: WatchEvent): void {
    switch (event.type) {
      case "turn.start": {
        const list = this.turns.get(event.sessionKey) ?? [];
        list.push({ source: turnSource(event.source, event.sessionKey), ...(event.requestId ? { requestId: event.requestId } : {}), startedAt: event.ts });
        this.turns.set(event.sessionKey, list);
        // A new turn: the last one's error no longer applies.
        if (this.trouble.get(event.sessionKey)?.kind === "error") this.trouble.delete(event.sessionKey);
        return;
      }
      case "turn.end":
        this.closeTurn(event.sessionKey, event.requestId, event.ts, false);
        return;
      case "turn.requeue":
        // Only the declined steer's own turn; never some other open turn.
        this.closeTurn(event.sessionKey, event.requestId, event.ts, true);
        return;
      case "tool.start": {
        const key = event.sessionKey ?? "";
        const list = this.tools.get(key) ?? [];
        const compact = SHELL.has(event.tool) && /\btomo\s+lcm\s+compact\b/.test(event.detail ?? "");
        list.push({ name: event.tool, kind: toolKind(event.tool), startedAt: event.ts, compact });
        if (list.length > 64) list.shift();
        this.tools.set(key, list);
        if (compact) this.compacting.set(key, event.ts);
        if (this.trouble.get(key)?.kind === "retry") this.trouble.delete(key);
        return;
      }
      case "tool.end": {
        const key = event.sessionKey ?? "";
        const list = this.tools.get(key);
        if (!list?.length) return;
        let index = -1;
        for (let i = list.length - 1; i >= 0; i--) if (event.tool === "?" || list[i].name === event.tool) { index = i; break; }
        if (index < 0) return;
        const [closed] = list.splice(index, 1);
        if (closed.compact && !list.some((t) => t.compact)) this.compacting.delete(key);
        if (!list.length) this.tools.delete(key);
        return;
      }
      case "tasks":
        if (event.tasks.length) this.tasks.set(event.sessionKey, event.tasks.slice(0, 256));
        else this.tasks.delete(event.sessionKey);
        return;
      case "cron.fired":
        this.cronAt = event.ts;
        return;
      case "compact":
        this.compacting.delete(event.sessionKey ?? "");
        return;
      case "sdk": {
        const key = event.sessionKey ?? "";
        const signal = event.signal;
        if (signal.kind === "retry") this.trouble.set(key, { kind: "retry", at: event.ts });
        else if (signal.kind === "error") this.trouble.set(key, { kind: "error", at: event.ts });
        else if (signal.kind === "rate_limit") {
          this.rateLimited = signal.status === "rejected"
            ? { at: event.ts, ...(signal.resetsAt !== undefined ? { until: signal.resetsAt } : {}) } : undefined;
        } else if (signal.kind === "compacting") {
          if (signal.active) this.compacting.set(key, event.ts); else this.compacting.delete(key);
        }
        return;
      }
      default:
        return;
    }
  }

  private closeTurn(key: string, requestId: string | undefined, at: number, exact: boolean): void {
    const list = this.turns.get(key);
    if (!list?.length) return;
    const index = requestId ? list.findIndex((t) => t.requestId === requestId) : -1;
    if (index < 0 && exact) return;
    list.splice(index >= 0 ? index : 0, 1);
    if (list.length) return;
    this.ended(key, at);
  }
  private ended(key: string, at: number): void {
    this.turns.delete(key);
    // The session's turn is over: its calls, its retry and its compaction with it.
    this.tools.delete(key);
    this.compacting.delete(key);
    if (this.trouble.get(key)?.kind === "retry") this.trouble.delete(key);
    if (this.turns.size === 0) this.idleSince = at;
  }

  /** Drops what outlived its bounds (a lost end event). */
  private expire(now: number): void {
    for (const [key, list] of this.turns) {
      const live = list.filter((t) => now - t.startedAt < TURN_STALE_MS);
      if (live.length === list.length) continue;
      if (live.length) this.turns.set(key, live);
      else this.ended(key, now);
    }
    for (const [key, since] of this.compacting) if (now - since >= COMPACT_STALE_MS) this.compacting.delete(key);
    for (const [key, trouble] of this.trouble) if (now - trouble.at >= TROUBLE_ERROR_MS) this.trouble.delete(key);
    if (this.rateLimited && ((this.rateLimited.until !== undefined && now >= this.rateLimited.until) || now - this.rateLimited.at >= RATE_LIMIT_MS)) this.rateLimited = undefined;
  }

  status(now: number, context: ReducerContext): HomeStatus {
    this.expire(now);
    const open: Array<OpenTurn & { key: string }> = [];
    for (const [key, list] of this.turns) for (const turn of list) open.push({ ...turn, key });
    open.sort((a, b) => b.startedAt - a.startedAt);
    const lead = open.find((t) => t.source === "owner") ?? open[0];

    let tool: HomeToolKind | undefined;
    const newest = (list: OpenTool[] | undefined) => list?.length ? list.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a)) : undefined;
    if (lead) tool = newest(this.tools.get(lead.key))?.kind;
    if (!tool && open.length) {
      let best: OpenTool | undefined;
      for (const [key, list] of this.tools) if (this.turns.has(key)) { const n = newest(list); if (n && (!best || n.startedAt >= best.startedAt)) best = n; }
      tool = best?.kind;
    }

    const subagents: Array<HomeSubagent & { startedAt: number }> = [];
    let tasks = 0;
    const allowed = new Map<string, boolean>();
    for (const [key, list] of this.tasks) {
      for (const task of list) {
        if (task.ambient || task.status) continue;
        if (task.taskType === "local_agent") {
          let show = allowed.get(key);
          if (show === undefined) { try { show = context.mayShowTask(key); } catch { show = false; } allowed.set(key, show); }
          const type = subagentTypeOf(task.subagentType);
          const text = show ? task.description.replace(/\s+/g, " ").trim().slice(0, HOME_TASK_CHARS) : "";
          subagents.push({ id: subagentId(key, task.taskId), ...(type ? { type } : {}), ...(text ? { task: text } : {}), startedAt: task.startedAt });
        } else if (task.background) tasks++;
      }
    }
    let running: readonly HomeSubsession[] = [];
    try { running = context.subsessions?.() ?? []; } catch { /* an unreadable table seats nobody */ }
    for (const s of running) {
      const text = s.title.replace(/\s+/g, " ").trim().slice(0, HOME_TASK_CHARS);
      subagents.push({ id: subsessionVisitorId(s.id), type: HOME_SUBSESSION_TYPE, ...(text ? { task: text } : {}), startedAt: s.startedAt });
    }
    subagents.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));

    let trouble: HomeStatus["trouble"];
    if (this.rateLimited) trouble = "rate_limit";
    else if ([...this.trouble.values()].some((t) => t.kind === "error")) trouble = "error";
    else if (this.trouble.size) trouble = "retry";

    const working = open.length > 0;
    return {
      working,
      ...(lead ? { by: lead.source } : {}),
      ...(tool ? { tool } : {}),
      subagents: subagents.slice(0, MAX_HOME_SUBAGENTS).map(({ startedAt: _startedAt, ...rest }) => rest),
      tasks,
      ...(this.cronAt !== undefined ? { cronAt: this.cronAt } : {}),
      ...(this.nextJobAt !== undefined ? { nextJobAt: this.nextJobAt } : {}),
      compacting: this.compacting.size > 0,
      ...(trouble ? { trouble } : {}),
      ...(!working ? { idleSince: this.idleSince } : {}),
      ...(this.pet ? { pet: this.pet } : {}),
      at: now,
    };
  }
}

/** Stable per subagent, and says nothing about which conversation it belongs to. */
export function subagentId(sessionKey: string, taskId: string): string {
  return createHash("sha256").update(`${sessionKey}\0${taskId}`).digest("hex").slice(0, 16);
}
/** Stable per sub-session; never the same as a subagent's id. */
export function subsessionVisitorId(id: string): string {
  return createHash("sha256").update(`subsession\0\0${id}`).digest("hex").slice(0, 16);
}
/** The SDK's subagent_type as a scene's visitors.kinds key can name it. */
export function subagentTypeOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const type = value.toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return type || undefined;
}
