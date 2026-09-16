import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError, sendMessage } from "./api.js";
import { useWeb } from "./use-web.js";
import type { HistoryPage, WebRequest } from "../../src/web/protocol.js";
import "./styles.css";

const labels: Record<WebRequest["state"], string> = { queued: "Queued", running: "Tomo is working…", completed: "Completed",
  failed: "Delivery failed — check the conversation before sending again", refused: "Message was not accepted", unknown: "Outcome unknown — check the conversation before sending again" };
type Theme = "system" | "light" | "dark";

function storedTheme(): Theme {
  try { const theme = localStorage.getItem("tomo-theme"); return theme === "light" || theme === "dark" ? theme : "system"; }
  catch { return "system"; }
}
function Mark() {
  return <svg className="mark" viewBox="0 0 40 40" aria-hidden="true"><path d="M 32 14 C 36 20, 32 32, 20 32 C 8 32, 5 22, 10 14 C 14 7, 26 6, 30 12" /></svg>;
}
function Text({ children }: { children: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    // Remote images would disclose local reading activity. Links require a
    // deliberate click and cannot take control of the local window.
    img: ({ alt }) => <span className="attachment">[Image: {alt || "not loaded"}]</span>,
    a: ({ href, children }) => href && /^https?:\/\//.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    input: ({ checked }) => <input type="checkbox" checked={checked ?? false} disabled aria-label={checked ? "Completed task" : "Incomplete task"} />,
  }}>{children}</Markdown>;
}

export function App() {
  const web = useWeb();
  const [selected, setSelected] = useState("");
  const selectedId = selected || web.bootstrap?.ownerId || web.bootstrap?.sessions[0]?.id || "";
  const session = web.bootstrap?.sessions.find((s) => s.id === selectedId);
  const [history, setHistory] = useState<HistoryPage>({ messages: [], nextCursor: null });
  const [historyStatus, setHistoryStatus] = useState("loading");
  const [reload, setReload] = useState(0);
  const historySession = useRef("");
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restoreScroll = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState<string | null>(() => {
    try { return sessionStorage.getItem("tomo-pending-request"); } catch { return null; }
  });
  const [feedback, setFeedback] = useState("");
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("tomo-theme", theme); } catch { /* Storage can be unavailable. */ }
  }, [theme]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    if (historySession.current !== selectedId) {
      historySession.current = selectedId;
      setHistory({ messages: [], nextCursor: null }); setHistoryStatus("loading"); atBottom.current = true;
    }
    void api<HistoryPage>(`/sessions/${selectedId}/messages`, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setHistory((old) => {
        if (old.revision !== value.revision) return value;
        const fresh = new Set(value.messages.map((m) => m.id));
        return { revision: value.revision, messages: [...old.messages.filter((m) => !fresh.has(m.id)), ...value.messages],
          nextCursor: old.messages.length > 100 ? old.nextCursor : value.nextCursor };
      });
      setHistoryStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setHistoryStatus("error"); });
    return () => controller.abort();
  }, [selectedId, web.revision, reload]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (restoreScroll.current !== null) { element.scrollTop = element.scrollHeight - restoreScroll.current; restoreScroll.current = null; }
    else if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [history, web.blocks]);

  useEffect(() => {
    web.discardRecordedBlocks(new Set(history.messages.filter((m) => m.role === "assistant" && m.requestId).map((m) => m.requestId!)));
  }, [history, web.discardRecordedBlocks]);

  const remember = (id: string | null) => {
    setUncertain(id);
    try { if (id) sessionStorage.setItem("tomo-pending-request", id); else sessionStorage.removeItem("tomo-pending-request"); } catch { /* Optional recovery hint. */ }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!session?.writable || !draft.trim() || sending || uncertain || !web.bootstrap || web.connection !== "live") return;
    const text = draft.trim();
    const requestId = crypto.randomUUID();
    setSending(true); setFeedback("Sending…"); remember(requestId);
    try {
      const request = await sendMessage({ requestId, targetId: session.id, text }, web.bootstrap, web.refreshBootstrap);
      setDraft((old) => old.trim() === text ? "" : old);
      setFeedback(labels[request.state]); remember(null); setReload((r) => r + 1); atBottom.current = true;
    } catch (err) {
      if (err instanceof ApiError && [400, 401, 403, 409, 413, 415, 429].includes(err.status)) {
        remember(null);
        setFeedback(err.status === 413 ? "Message is too large. Shorten it and send again; your draft is kept."
          : err.status === 401 ? "Open the access link from tomo start to reconnect. Your draft is kept."
          : err.code === "owner_dm_only" ? "Group conversations are read-only." : "Message was not accepted. Your draft is saved here; reconnect or check web settings.");
      } else setFeedback(labels.unknown);
    } finally { setSending(false); }
  };
  const checkOutcome = async () => {
    if (!uncertain) return;
    try {
      const request = await api<WebRequest>(`/messages/${uncertain}`);
      setFeedback(labels[request.state]);
      if (request.state !== "unknown") { remember(null); if (request.state !== "refused") setDraft(""); }
      setReload((r) => r + 1);
    } catch { setFeedback("Cannot check yet. Your draft is still here."); }
  };
  const older = async () => {
    if (!history.nextCursor || historyStatus === "loading-older") return;
    const target = selectedId;
    setHistoryStatus("loading-older");
    try {
      const value = await api<HistoryPage>(`/sessions/${target}/messages?cursor=${encodeURIComponent(history.nextCursor)}`);
      if (historySession.current !== target) return;
      const element = scroll.current;
      if (element) restoreScroll.current = element.scrollHeight - element.scrollTop;
      setHistory((old) => ({ revision: value.revision, messages: [...value.messages.filter((m) => !old.messages.some((item) => item.id === m.id)), ...old.messages], nextCursor: value.nextCursor }));
      setHistoryStatus("ready");
    } catch (error) {
      if (historySession.current !== target) return;
      if (error instanceof ApiError && error.status === 409 && error.code === "history_changed") {
        setHistory({ messages: [], nextCursor: null }); setHistoryStatus("loading");
        restoreScroll.current = null; atBottom.current = true; setReload((value) => value + 1);
      } else setHistoryStatus("error");
    }
  };
  const durable = new Set(history.messages.filter((m) => m.role === "assistant").map((m) => m.requestId).filter(Boolean));
  const blocks = web.blocks.filter((b) => b.sessionId === selectedId && !durable.has(b.requestId));
  const latest = web.requests.filter((r) => r.sessionId === selectedId).at(-1);
  const usage = session?.stats;
  const hasContext = !!usage?.contextMax;
  return <div className="shell">
    <a className="skip" href="#conversation">Skip to conversation</a>
    <header className="topbar"><a className="brand" href="/" aria-label="Tomo home"><Mark /><span>tomo<span className="brand-dot">.</span></span></a>
      <span className="section-name">Conversation</span>
      <div className="header-actions"><span className={`connection ${web.connection}`} role="status"><i />{web.connection === "live" ? "Connected" : web.connection === "locked" ? "Access link required" : web.connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        <label className="theme-label"><span className="sr-only">Color theme</span><select aria-label="Color theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}><option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option></select></label>
      </div>
    </header>
    <div className="workspace">
      <aside className="sidebar" aria-label="Conversation details">
        <p className="eyebrow">Your conversations</p>
        <label htmlFor="session">Session</label>
        <select id="session" value={selectedId} disabled={!web.bootstrap?.sessions.length} onChange={(e) => { setSelected(e.target.value); setFeedback(""); }}>
          {!web.bootstrap?.sessions.length && <option value="">No session available</option>}
          {web.bootstrap?.sessions.map((s) => <option value={s.id} key={s.id}>{s.title}{s.kind === "group" ? " · read-only" : ""}</option>)}
        </select>
        <p className="session-note">{session?.kind === "group" ? "Shared history. Messages can be sent from the group's messaging channel." : "The same conversation you share with Tomo across your messaging channels."}</p>
        <section className="context" aria-labelledby="context-heading"><p className="eyebrow" id="context-heading">Context window</p>
          <p className="usage">{hasContext ? <>{usage!.contextUsed.toLocaleString()} <span>/ {usage!.contextMax.toLocaleString()}</span></> : "Unavailable"}</p>
          {hasContext && <progress max={usage!.contextMax} value={Math.min(usage!.contextUsed, usage!.contextMax)} aria-label="Context tokens used" />}
          <p className="session-note">{hasContext ? `${usage?.contextEstimated ? "Estimated" : "Reported"} tokens · last recorded turn` : "Usage appears after a turn reports its context window."}</p>
        </section>
        <div className="local-note"><Mark /><p>A quiet place<br />to think together.</p><span>Your private workspace</span></div>
      </aside>
      <main id="conversation" className="conversation" tabIndex={-1}>
        <div className="conversation-heading"><div><p className="eyebrow">{session?.kind === "group" ? "Group history" : "A conversation with Tomo"}</p><h1>{session?.kind === "group" ? session.title : "Room to think."}</h1></div><span className="scope">{session?.kind === "group" ? "Read-only" : "Owner DM"}</span></div>
        {web.bootstrap?.setupRequired && <div className="notice" role="alert">Choose an owner in <code>web.ownerIdentity</code> and restart Tomo. An unambiguous owner is required to chat.</div>}
        {web.connection === "locked" && <div className="notice" role="alert">Open the access link shown by <code>tomo start</code> to connect. The link includes your private access token.</div>}
        <div className="transcript" ref={scroll} aria-label="Conversation history" tabIndex={0} onScroll={() => { const e = scroll.current!; atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
          {history.nextCursor && <button className="older" onClick={() => void older()} disabled={historyStatus === "loading-older"}>{historyStatus === "loading-older" ? "Loading…" : "Load earlier messages"}</button>}
          {historyStatus === "error" && <div className="notice" role="alert">History is unavailable. <button onClick={() => setReload((r) => r + 1)}>Try again</button></div>}
          {historyStatus === "loading" && selectedId && <p className="empty-note" role="status">Opening your conversation…</p>}
          {historyStatus === "ready" && history.messages.length === 0 && blocks.length === 0 && <div className="empty"><Mark /><h2>Start wherever you are.</h2><p>{session?.kind === "group" ? "There are no recorded messages in this group yet." : "A question, a half-formed idea, or something on your mind."}</p></div>}
          {history.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-meta"><span>{message.role === "assistant" ? "Tomo" : message.role === "user" ? (session?.kind === "group" ? "Participant" : "You") : "System"}</span><time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{message.channel === "web" ? "Web" : message.channel}</span></div><div className="markdown"><Text>{message.content}</Text></div></article>)}
          {blocks.map((block) => <article className="message assistant" key={block.id}><div className="message-meta"><span>Tomo</span><span>Reply in progress</span></div><div className="markdown"><Text>{block.text}</Text></div></article>)}
        </div>
        <div className="composer-area"><div className="activity" role="status" aria-live="polite">{web.activity[selectedId] || (latest && labels[latest.state]) || feedback}</div>
          <form onSubmit={(e) => void send(e)} className="composer"><label className="sr-only" htmlFor="message">Message Tomo</label><textarea id="message" placeholder={session?.kind === "group" ? "This group is read-only" : "What's on your mind?"} value={draft} maxLength={16_000} rows={3} disabled={!session?.writable} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <div className="composer-footer"><span>{session?.kind === "group" ? "View only" : "Enter to send · Shift + Enter for a new line"}</span><button className="send" type="submit" disabled={!session?.writable || !draft.trim() || sending || !!uncertain || web.connection !== "live"}>{sending ? "Sending…" : "Send"}<span aria-hidden="true">↗</span></button></div>
          </form>
          {feedback && <p className="feedback" role="status">{feedback}</p>}
          {uncertain && !sending && <div className="recovery"><button onClick={() => void checkOutcome()}>Check message status</button><button onClick={() => { remember(null); setFeedback("Draft kept. Review the conversation before sending it again."); }}>Keep draft for review</button></div>}
        </div>
      </main>
    </div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
