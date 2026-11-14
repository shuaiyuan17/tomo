import { useCallback, useEffect, useState } from "react";
import { api, ApiError, readBootstrap, stream, type WebBootstrap } from "./api.js";
import type { WebEvent, WebRequest, WebSnapshot, WebTask } from "../../src/web/protocol.js";
import { replaceSessionTasks } from "./tasks.js";
import { trimRequests } from "./pending.js";

export function useWeb() {
  const [bootstrap, setBootstrap] = useState<WebBootstrap>();
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "locked">("connecting");
  const [blocks, setBlocks] = useState<WebSnapshot["blocks"]>([]);
  const [requests, setRequests] = useState<WebRequest[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<WebTask[]>([]);
  const [revision, setRevision] = useState(0);
  /** Bumped whenever the daemon reports a cron run; Study / Scheduled re-read /cron. */
  const [cronRevision, setCronRevision] = useState(0);
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
      setBlocks(value.blocks); setRequests(value.requests); setActivity({}); setTasks(value.tasks ?? []);
      // A (re)connect may have missed cron events while the stream was down.
      setConnection("live"); refresh(); setCronRevision((r) => r + 1);
    };
    const update = (event: WebEvent) => {
      if (event.type === "block") setBlocks((old) => [...old.filter((b) => b.id !== event.id), event]);
      if (event.type === "request") {
        setRequests((old) => trimRequests([...old.filter((r) => r.requestId !== event.request.requestId), event.request]));
        if (!["queued", "running"].includes(event.request.state)) refresh();
      }
      if (event.type === "invalidate") refresh();
      if (event.type === "cron") setCronRevision((value) => value + 1);
      if (event.type === "tool") setActivity((old) => ({ ...old,
        [event.sessionId]: `${event.tool} · ${event.state}` }));
      if (event.type === "tasks") setTasks((old) => replaceSessionTasks(old, event.sessionId, event.tasks));
      if (event.type === "typing") setActivity((old) => ({ ...old, [event.sessionId]: event.active ? "Tomo is working…" : "" }));
    };
    let delay = 1_000;
    const connect = async () => {
      try {
        const value = await readBootstrap(controller.signal);
        if (controller.signal.aborted) return;
        if (epoch !== value.epoch) { cursor = value.cursor; epoch = value.epoch; }
        setBootstrap(value);
        snapshot(value);
        delay = 1_000;
        await stream(cursor || value.cursor, controller.signal, { snapshot, update, cursor: (value) => { cursor = value; } });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) { setConnection("locked"); return; }
        setConnection("reconnecting");
        retryTimer = setTimeout(() => { void connect(); }, delay);
        delay = Math.min(delay * 2, 10_000);
      }
    };
    void connect();
    return () => { controller.abort(); clearTimeout(invalidation); clearTimeout(retryTimer); };
  }, []);
  return { bootstrap, connection, blocks, requests, activity, tasks, revision, cronRevision, discardRecordedBlocks, refreshBootstrap, acceptRequest, applyRequest };
}
