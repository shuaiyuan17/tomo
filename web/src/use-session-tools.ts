import { useEffect, useRef, useState } from "react";
import type { SessionTools } from "../../src/web/protocol.js";
import { api, ApiError } from "./api.js";
import { mergeTools, NO_TOOLS, type ToolsState } from "./inline-tools.js";

/** While a turn runs, read the transcript's new lines this often (tool events also trigger a read). */
export const TOOLS_POLL_MS = 1_500;
/** After a tool event: the SDK may write its line just after the event, so the read waits this long. */
const AFTER_EVENT_MS = 120;

/** Subscribes to the event stream's tool events (by session id); returns the unsubscribe. */
export type ToolEvents = (listener: (sessionId: string) => void) => () => void;

/**
 * The inline tool calls of one conversation: a scan back to `since` whenever
 * the conversation or the oldest loaded message changes, then tail reads
 * (`after`) on every tool event and `revision` change, and on a timer while a
 * turn runs. A reset (the transcript was replaced) rescans. The state changes
 * only when a read finds something new.
 */
export function useSessionTools(sessionId: string, since: number | null, revision: number, active: boolean, onToolEvent: ToolEvents): ToolsState {
  const [state, setState] = useState<ToolsState>(NO_TOOLS);
  const ref = useRef(state);
  const scope = useRef("");
  const [rescan, setRescan] = useState(0);
  const set = (next: ToolsState) => { ref.current = next; setState(next); };

  useEffect(() => {
    if (!sessionId || since === null) return;
    if (scope.current !== sessionId) { scope.current = sessionId; set(NO_TOOLS); }
    const controller = new AbortController();
    void api<SessionTools>(`/sessions/${sessionId}/tools?from=${Math.max(0, Math.floor(since))}`, { signal: controller.signal })
      .then((page) => { if (!controller.signal.aborted) set(mergeTools(ref.current, page, "full")); }, () => {});
    return () => controller.abort();
  }, [sessionId, since, rescan]);

  useEffect(() => {
    if (!sessionId || since === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One read at a time; an event during a read asks for another right after it.
    let reading = false, again = false;
    const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => void read(), ms); };
    const read = async () => {
      reading = true; again = false;
      const current = ref.current;
      try {
        if (current.transcript) {
          const page = await api<SessionTools>(`/sessions/${sessionId}/tools?after=${current.end}&transcript=${encodeURIComponent(current.transcript)}`, { signal: controller.signal });
          if (!controller.signal.aborted && ref.current.transcript === current.transcript) set(mergeTools(ref.current, page, "newer"));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 409) { setRescan((value) => value + 1); return; }
      } finally { reading = false; }
      if (controller.signal.aborted) return;
      if (again) schedule(AFTER_EVENT_MS);
      else if (active) schedule(TOOLS_POLL_MS);
    };
    const soon = () => { if (reading) again = true; else schedule(AFTER_EVENT_MS); };
    soon();
    const stop = onToolEvent((id) => { if (id === sessionId) soon(); });
    return () => { controller.abort(); clearTimeout(timer); stop(); };
  }, [sessionId, since, revision, active, onToolEvent]);

  return scope.current === sessionId ? state : NO_TOOLS;
}
