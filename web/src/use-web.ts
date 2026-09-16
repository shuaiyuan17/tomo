import { useCallback, useEffect, useState } from "react";
import { api, ApiError, readBootstrap, stream, type WebBootstrap } from "./api.js";
import type { WebEvent, WebRequest, WebSnapshot } from "../../src/web/protocol.js";

export function useWeb() {
  const [bootstrap, setBootstrap] = useState<WebBootstrap>();
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "locked">("connecting");
  const [blocks, setBlocks] = useState<WebSnapshot["blocks"]>([]);
  const [requests, setRequests] = useState<WebRequest[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const refreshBootstrap = useCallback(async () => {
    try { const value = await readBootstrap(); setBootstrap(value); return value; }
    catch (error) { if (error instanceof ApiError && error.status === 401) setConnection("locked"); throw error; }
  }, []);
  const discardRecordedBlocks = useCallback((requestIds: Set<string>) => {
    setBlocks((old) => old.some((block) => requestIds.has(block.turnId ?? block.requestId))
      ? old.filter((block) => !requestIds.has(block.turnId ?? block.requestId)) : old);
  }, []);
  const acceptRequest = useCallback((request: WebRequest) => {
    setRequests((old) => [...old.filter((r) => r.requestId !== request.requestId), { ...request, ...old.find((r) => r.requestId === request.requestId), text: request.text }].slice(-128));
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
      setBlocks(value.blocks); setRequests(value.requests); setActivity({});
      setConnection("live"); refresh();
    };
    const update = (event: WebEvent) => {
      if (event.type === "block") setBlocks((old) => [...old.filter((b) => b.id !== event.id), event]);
      if (event.type === "request") {
        setRequests((old) => [...old.filter((r) => r.requestId !== event.request.requestId), event.request].slice(-128));
        if (!["queued", "running"].includes(event.request.state)) refresh();
      }
      if (event.type === "invalidate") refresh();
      if (event.type === "tool") setActivity((old) => ({ ...old,
        [event.sessionId]: `${event.tool} · ${event.state}` }));
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
  return { bootstrap, connection, blocks, requests, activity, revision, discardRecordedBlocks, refreshBootstrap, acceptRequest };
}
