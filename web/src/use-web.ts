import { useCallback, useEffect, useState } from "react";
import { api, ApiError, readBootstrap, stream, type WebBootstrap } from "./api.js";
import type { WebCompactState, WebCredentialRequest, WebEvent, WebRateLimit, WebReaction, WebRequest, WebSnapshot, WebTask } from "../../src/web/protocol.js";
import { replaceSessionTasks } from "./tasks.js";
import { trimRequests } from "./pending.js";
import { isTransient, TYPING_ACTIVITY, type TurnStatus } from "./composer-status.js";
import { onResume } from "./resume.js";
import { localizeHomeStatus, newerStatus, type LocalHomeStatus } from "./home/caption.js";

/** Hidden at least this long, the page reconnects its event stream when it shows again. */
export const RESUME_RECONNECT_MS = 5_000;

/** Tomo's home as the event stream reports it: the latest status, a counter to re-read /home on, and the latest request to look. */
export interface HomeEvents { status?: LocalHomeStatus; revision: number; look?: { requestId: string; seq: number } }

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
export function useWeb() {
  const [bootstrap, setBootstrap] = useState<WebBootstrap>();
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "locked">("connecting");
  const [blocks, setBlocks] = useState<WebSnapshot["blocks"]>([]);
  const [requests, setRequests] = useState<WebRequest[]>([]);
  /** Tomo's reactions on the owner's web messages, by request id. */
  const [reactions, setReactions] = useState<Record<string, WebReaction>>({});
  const [activity, setActivity] = useState<Record<string, string>>({});
  /** Bumped per session on every tool event: the chat re-reads its inline tool calls. */
  const [toolTicks, setToolTicks] = useState<Record<string, number>>({});
  const [tasks, setTasks] = useState<WebTask[]>([]);
  const [compact, setCompact] = useState<WebCompactState>();
  /** The open credential request (the password card); null: none. Never a value. */
  const [credentialRequest, setCredentialRequest] = useState<WebCredentialRequest | null>(null);
  /** What the SDK last reported about each conversation's turn (retry, tool progress, refusal, error, stopped). */
  const [turns, setTurns] = useState<Record<string, TurnStatus>>({});
  /** The subscription's live rate-limit state, on the local clock. */
  const [rateLimit, setRateLimit] = useState<WebRateLimit>();
  /** The SDK's predicted next message per conversation. */
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  /** Bumped whenever the daemon reports a cron run; Study / Scheduled re-read /cron. */
  const [cronRevision, setCronRevision] = useState(0);
  const [home, setHome] = useState<HomeEvents>({ revision: 0 });
  const refreshBootstrap = useCallback(async () => {
    try { const value = await readBootstrap(); setBootstrap(value); return value; }
    catch (error) { if (error instanceof ApiError && error.status === 401) setConnection("locked"); throw error; }
  }, []);
  /** Drops live blocks the canonical history now records. A block belongs to
   *  the turn that wrote it (`turnId`), which differs from its request when the
   *  request joined a running turn. */
  const discardRecordedBlocks = useCallback((recordedIds: Set<string>) => {
    setBlocks((old) => old.some((block) => recordedIds.has(block.turnId ?? block.requestId))
      ? old.filter((block) => !recordedIds.has(block.turnId ?? block.requestId)) : old);
  }, []);
  /** The POST answer for a message this tab sent: its bubble shows at once,
   *  before the request event or the transcript catches up (#381). */
  const acceptRequest = useCallback((request: WebRequest) => {
    setRequests((old) => {
      const known = old.find((r) => r.requestId === request.requestId);
      return trimRequests([...old.filter((r) => r.requestId !== request.requestId), { ...request, ...known, text: known ? known.text : request.text }]);
    });
  }, []);
  /** The daemon's answer to a mutation of an existing request (dismiss): it replaces the local copy. */
  const applyRequest = useCallback((request: WebRequest) => {
    setRequests((old) => trimRequests([...old.filter((r) => r.requestId !== request.requestId), request]));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let cursor = "";
    let epoch = "";
    let invalidation: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(invalidation);
      invalidation = setTimeout(() => {
        setRevision((r) => r + 1);
        void api<Pick<WebBootstrap, "sessions" | "ownerId" | "setupRequired">>("/sessions", { signal: controller.signal })
          .then((catalog) => setBootstrap((old) => old && { ...old, ...catalog })).catch(() => {});
      }, 100);
    };
    const snapshot = (value: WebSnapshot) => {
      setBlocks(value.blocks); setRequests(value.requests); setReactions(value.reactions ?? {}); setActivity({}); setTasks(value.tasks ?? []); setCompact(value.compact); setCredentialRequest(value.credentialRequest ?? null);
      // Turn statuses are of the moment: a (re)connect starts without them.
      setTurns({}); setSuggestions(value.suggestions ?? {});
      setRateLimit(value.rateLimit);
      // A (re)connect may have missed cron events while the stream was down.
      setConnection("live"); refresh(); setCronRevision((r) => r + 1);
      // Home events may have been missed too: the page re-reads /home.
      setHome((old) => ({ ...old, revision: old.revision + 1 }));
    };
    const update = (event: WebEvent) => {
      if (event.type === "block") setBlocks((old) => [...old.filter((b) => b.id !== event.id), event]);
      // Content or a tool boundary means the turn moved on: a retry or a tool's progress no longer describes it.
      if (event.type === "block" || event.type === "tool") {
        setTurns((old) => old[event.sessionId] && isTransient(old[event.sessionId].status) ? without(old, event.sessionId) : old);
      }
      if (event.type === "turn") {
        const { sessionId, status } = event;
        setTurns((old) => status ? { ...old, [sessionId]: { status, at: Date.now() } } : old[sessionId] ? without(old, sessionId) : old);
      }
      if (event.type === "rate-limit") setRateLimit(event.limit);
      if (event.type === "suggestion") {
        const { sessionId, text } = event;
        setSuggestions((old) => text ? { ...old, [sessionId]: text } : old[sessionId] ? without(old, sessionId) : old);
      }
      if (event.type === "request") {
        setRequests((old) => trimRequests([...old.filter((r) => r.requestId !== event.request.requestId), event.request]));
        if (!["queued", "running"].includes(event.request.state)) refresh();
      }
      if (event.type === "invalidate") refresh();
      if (event.type === "cron") setCronRevision((value) => value + 1);
      if (event.type === "home") setHome((old) => ({ ...old, revision: old.revision + 1 }));
      if (event.type === "home-status") { const status = localizeHomeStatus(event.status, Date.now()); setHome((old) => ({ ...old, status: newerStatus(old.status, status) })); }
      if (event.type === "home-look") { const { requestId } = event; setHome((old) => ({ ...old, look: { requestId, seq: (old.look?.seq ?? 0) + 1 } })); }
      // Tool calls show inline in the chat (the running one in its group's
      // summary), not as a separate line above the composer.
      if (event.type === "tool") setToolTicks((old) => ({ ...old, [event.sessionId]: (old[event.sessionId] ?? 0) + 1 }));
      if (event.type === "compact") setCompact(event.request);
      if (event.type === "credential-request") setCredentialRequest(event.request);
      if (event.type === "tasks") setTasks((old) => replaceSessionTasks(old, event.sessionId, event.tasks));
      if (event.type === "reaction") {
        const { requestId, reaction } = event;
        setReactions((old) => reaction ? { ...old, [requestId]: reaction } : old[requestId] ? without(old, requestId) : old);
      }
      if (event.type === "typing") setActivity((old) => ({ ...old, [event.sessionId]: event.active ? TYPING_ACTIVITY : "" }));
    };
    let delay = 1_000;
    /** The current connection attempt: dropped on its own when the page comes back (see below). */
    let attempt: AbortController | undefined;
    let locked = false;
    const connect = async () => {
      clearTimeout(retryTimer);
      attempt?.abort();
      const own = attempt = new AbortController();
      try {
        const value = await readBootstrap(own.signal);
        if (own.signal.aborted) return;
        if (epoch !== value.epoch) { cursor = value.cursor; epoch = value.epoch; }
        setBootstrap(value);
        snapshot(value);
        delay = 1_000;
        await stream(cursor || value.cursor, own.signal, { snapshot, update, cursor: (value) => { cursor = value; } });
      } catch (error) {
        if (own.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) { locked = true; setConnection("locked"); return; }
        setConnection("reconnecting");
        retryTimer = setTimeout(() => { void connect(); }, delay);
        delay = Math.min(delay * 2, 10_000);
      }
    };
    controller.signal.addEventListener("abort", () => attempt?.abort());
    void connect();
    // Back from the background (or the back/forward cache): the stream may
    // be dead without knowing it, and whatever it missed is missed. A fresh
    // connection re-reads the bootstrap and snapshot (and so /home). A brief
    // tab switch keeps a stream that is still flowing.
    const stopResume = onResume((hiddenFor) => {
      if (locked || hiddenFor < RESUME_RECONNECT_MS) return;
      delay = 1_000;
      void connect();
    });
    return () => { controller.abort(); stopResume(); clearTimeout(invalidation); clearTimeout(retryTimer); };
  }, []);
  return { bootstrap, connection, blocks, requests, reactions, activity, toolTicks, tasks, compact, credentialRequest, turns, rateLimit, suggestions, revision, cronRevision, home, discardRecordedBlocks, refreshBootstrap, acceptRequest, applyRequest };
}
