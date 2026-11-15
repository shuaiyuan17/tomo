import { useEffect, useRef, useState } from "react";
import type { SessionTools } from "../../src/web/protocol.js";
import { api, ApiError } from "./api.js";
import { mergeTools, NO_TOOLS, type ToolsState } from "./inline-tools.js";

/** While a turn runs, read the transcript's new lines this often (tool events also trigger a read). */
export const TOOLS_POLL_MS = 1_500;

/**
 * The inline tool calls of one conversation: a scan back to `since` whenever
 * the conversation or the oldest loaded message changes, then tail reads
 * (`after`) on every tool event / history change, and on a timer while a
 * turn runs. A reset (the transcript was replaced) rescans.
 */
export function useSessionTools(sessionId: string, since: number | null, tick: number, active: boolean): ToolsState {
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
    const read = async () => {
      const current = ref.current;
      if (current.transcript) {
        try {
          const page = await api<SessionTools>(`/sessions/${sessionId}/tools?after=${current.end}&transcript=${encodeURIComponent(current.transcript)}`, { signal: controller.signal });
          if (!controller.signal.aborted && ref.current.transcript === current.transcript) set(mergeTools(ref.current, page, "newer"));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 409) { setRescan((value) => value + 1); return; }
        }
      }
      if (active && !controller.signal.aborted) timer = setTimeout(() => void read(), TOOLS_POLL_MS);
    };
    // A tool event can land just before the SDK writes its line: read now, and again shortly.
    timer = setTimeout(() => void read(), 120);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, since, tick, active]);

  return scope.current === sessionId ? state : NO_TOOLS;
}
