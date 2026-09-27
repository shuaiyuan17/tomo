import { useEffect, useState, type FormEvent } from "react";
import type { WebSession } from "../../src/web/protocol.js";
import type { MemoryReader, MemoryFile } from "../../src/workspace/memory-reader.js";
import type { WebCron, readSessionContext } from "../../src/web/inspection.js";
import { mutate } from "./api.js";
import { useWeb } from "./use-web.js";
import { Text } from "./content.js";
import { Dialog, failure, ResourceState, useResource, when } from "./study-ui.js";
import { ConfigPage, McpPage } from "./study-settings.js";
export type StudyPage = "todos" | "cron" | "memory" | "context" | "mcp" | "config";
export type WebState = ReturnType<typeof useWeb>;
export interface StudyProps { page: StudyPage; selectedId: string; session?: WebSession; web: WebState }
const titles: Record<StudyPage, [string, string]> = {
  todos: ["One thing at a time.", "Your workspace TODO files, with every checkbox as Tomo left it."],
  cron: ["A little ahead of time.", "Scheduled work, its destination, and what happened last."],
  memory: ["A place for what stays.", "Browse and search the notes in your workspace memory directory."],
  context: ["What’s in mind.", "Recorded context usage and the summaries that keep a conversation going."],
  mcp: ["Tools within reach.", "Configured servers and the connections reported by active sessions."],
  config: ["Make it your own.", "Review saved settings, preview a diff, then apply your changes."],
};
export function Study(props: StudyProps) {
  const { page, web } = props;
  return <main id="study" className="study" tabIndex={-1} key={page}>
    <header className="study-heading"><p className="eyebrow">The Study / {page === "mcp" ? "MCP servers" : page}</p><h1>{titles[page][0]}</h1><p>{titles[page][1]}</p></header>
    {web.connection === "locked" ? <div className="notice" role="alert">Open the private access link to use the Study.</div> : <>
      {page === "todos" && <Todos version={web.revision} />}
      {page === "cron" && <CronPage web={web} />}
      {page === "memory" && <MemoryPage version={web.revision} />}
      {page === "context" && <ContextPage {...props} />}
      {page === "mcp" && <McpPage web={web} />}
      {page === "config" && <ConfigPage web={web} />}
    </>}
  </main>;
}
function Todos({ version }: { version: number }) {
  const data = useResource<Awaited<ReturnType<MemoryReader["todos"]>>>("/todos", version);
  return <><div className="page-toolbar"><span className="scope">Read-only</span><button onClick={data.reload}>Refresh TODOs</button></div><ResourceState {...data} retry={data.reload} />
    {data.value && <>{data.value.truncated && <p className="notice">The listing reached its limit. Open Memory to browse individual files.</p>}
      {!data.value.files.length && <p className="empty-note">{data.value.missing ? "The memory directory has not been created yet." : "No TODO*.md files yet. Ask Tomo to keep a TODO list in workspace memory."}</p>}
      {data.value.files.map((file) => <section className="paper-section" key={file.path}><h2>{file.path}</h2>{"content" in file ? <div className="markdown todo-markdown"><Text>{file.content}</Text></div> : <p role="alert">This file is unavailable ({file.error}).</p>}</section>)}</>}
  </>;
}
function CronPage({ web }: { web: WebState }) {
  const data = useResource<ReturnType<WebCron["list"]>>("/cron", web.revision);
  type Job = NonNullable<typeof data.value>["jobs"][number];
  const [review, setReview] = useState<{ job: Job; operation: "enable" | "disable" | "delete" }>();
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const apply = async () => {
    if (!review || !web.bootstrap) return;
    setBusy(true); setNotice("");
    try { await mutate(`/cron/${encodeURIComponent(review.job.id)}`, { revision: review.job.revision, confirm: true,
      ...(review.operation === "delete" ? {} : { enabled: review.operation === "enable" }) }, web.bootstrap, web.refreshBootstrap, review.operation === "delete" ? "DELETE" : "PATCH");
      setNotice("Task updated."); setReview(undefined); data.reload();
    } catch (err) { setNotice(failure(err)); } finally { setBusy(false); }
  };
  return <><div className="page-toolbar"><span>{data.value ? `${data.value.jobs.length} scheduled tasks` : "Scheduled tasks"}</span><button onClick={data.reload}>Refresh cron</button></div><ResourceState {...data} retry={data.reload} />
    {notice && !review && <p className="notice" role="status">{notice}</p>}
    {data.value?.jobs.length === 0 && <p className="empty-note">No scheduled tasks yet. Ask Tomo to schedule something from your conversation.</p>}
    {data.value?.jobs.map((job) => <article className="paper-section cron-job" key={job.id}><div className="section-top"><h2>{job.name}</h2><span className="scope">{job.enabled ? "Enabled" : "Disabled"}</span></div>
      <p className="schedule-label">{job.scheduleLabel}</p><dl className="facts"><div><dt>Next run</dt><dd>{when(job.nextRunAt)}</dd></div><div><dt>Last run</dt><dd>{when(job.lastRunAt)}</dd></div><div><dt>Last status</dt><dd>{job.lastStatus ?? "Not run yet"}</dd></div><div><dt>Target session</dt><dd><code>{job.sessionKey}</code></dd></div></dl>
      <details><summary>Message body</summary><div className="markdown"><Text>{job.message}</Text></div></details>
      <div className="row-actions"><button onClick={() => { setNotice(""); setReview({ job, operation: job.enabled ? "disable" : "enable" }); }}>{job.enabled ? "Disable" : "Enable"}</button><button onClick={() => { setNotice(""); setReview({ job, operation: "delete" }); }}>Delete</button></div>
    </article>)}
    {review && <Dialog title={`${review.operation[0].toUpperCase() + review.operation.slice(1)} scheduled task?`} busy={busy} cancel={() => setReview(undefined)} confirm={() => void apply()} action={`Confirm ${review.operation}`}>
      <p><strong>{review.job.name}</strong></p><p>{review.job.scheduleLabel}</p><p>Target: <code>{review.job.sessionKey}</code></p><p>A run already in progress will continue.</p>
      {review.operation === "enable" && review.job.schedule.kind === "at" && new Date(review.job.schedule.at).getTime() <= Date.now() && <p className="notice">This one-shot is overdue. Enabling it schedules it for the next scheduler poll.</p>}
      {notice && <p role="alert">{notice}</p>}
    </Dialog>}
  </>;
}
function MemoryPage({ version }: { version: number }) {
  const tree = useResource<Awaited<ReturnType<MemoryReader["tree"]>>>("/memory/tree", version);
  const [selected, setSelected] = useState(""); const [search, setSearch] = useState(""); const [query, setQuery] = useState("");
  useEffect(() => { if (!selected && tree.value) setSelected(tree.value.entries.find((e) => e.kind === "file")?.path ?? ""); }, [selected, tree.value]);
  const submit = (event: FormEvent) => { event.preventDefault(); setQuery(search.trim()); };
  return <><div className="page-toolbar"><span className="scope">Read-only</span><button onClick={tree.reload}>Refresh memory</button></div><ResourceState {...tree} retry={tree.reload} />
    <form className="memory-search" onSubmit={submit}><label className="sr-only" htmlFor="memory-search">Search memory</label><input id="memory-search" type="search" maxLength={200} placeholder="Search the notes…" value={search} onChange={(e) => setSearch(e.target.value)} /><button type="submit">Search</button>{query && <button type="button" onClick={() => { setQuery(""); setSearch(""); }}>Clear</button>}</form>
    {query && <MemorySearch query={query} version={version} open={setSelected} />}
    {tree.value?.truncated && <p className="notice">The file listing reached its depth, time, or 1,000-entry limit.</p>}
    {tree.value?.entries.length === 0 && <p className="empty-note">{tree.value.missing ? "The memory directory has not been created yet." : "No markdown notes yet."}</p>}
    <div className="memory-layout"><nav className="file-tree" aria-label="Memory files">{tree.value?.entries.map((entry) => entry.kind === "directory" ? <p className="directory" key={entry.path}>{entry.path}/</p> : <button key={entry.path} aria-current={selected === entry.path ? "page" : undefined} onClick={() => setSelected(entry.path)}>{entry.path}</button>)}</nav>
      {selected ? <MemoryDocument path={selected} version={version} /> : <div className="paper-section empty-note">Choose a note to read.</div>}
    </div>
  </>;
}
function MemorySearch({ query, version, open }: { query: string; version: number; open(path: string): void }) {
  const data = useResource<Awaited<ReturnType<MemoryReader["search"]>>>(`/memory/search?q=${encodeURIComponent(query)}`, version);
  return <section className="search-results" aria-label="Search results"><ResourceState {...data} retry={data.reload} />{data.value && <>
    <p>{data.value.results.length} matches{data.value.truncated ? " · search limit reached" : ""}{data.value.unreadable ? ` · ${data.value.unreadable} unreadable files` : ""}</p>
    {data.value.results.map((result) => <button key={`${result.path}:${result.line}`} onClick={() => open(result.path)}><strong>{result.path}:{result.line}</strong><span>{result.text}</span></button>)}
  </>}</section>;
}
function MemoryDocument({ path, version }: { path: string; version: number }) {
  const data = useResource<MemoryFile>(`/memory/file?path=${encodeURIComponent(path)}`, version);
  return <section className="paper-section memory-document"><ResourceState {...data} retry={data.reload} />{data.value && <><h2>{data.value.path}</h2><p className="file-date">Updated {when(data.value.modifiedAt)}</p><div className="markdown"><Text>{data.value.content}</Text></div></>}</section>;
}
function ContextPage({ selectedId, session, web }: StudyProps) {
  return selectedId ? <SessionContext key={selectedId} id={selectedId} session={session} version={web.revision} /> : <p className="empty-note">Select a conversation to inspect its context.</p>;
}
function SessionContext({ id, session, version }: { id: string; session?: WebSession; version: number }) {
  type Context = Awaited<ReturnType<typeof readSessionContext>> & { recentCompactions: Array<{ timestamp: number; preTokens?: number; postTokens?: number }> };
  const data = useResource<Context>(`/sessions/${id}/context`, version); const value = data.value;
  return <><div className="page-toolbar"><span>{session?.title} {session?.kind === "group" && "· read-only"}</span><button onClick={data.reload}>Refresh context</button></div><ResourceState {...data} retry={data.reload} />
    {value && <><section className="paper-section context-summary"><p className="eyebrow">Last recorded context window</p><p className="context-big">{value.used?.toLocaleString() ?? "—"}<span> / {value.max?.toLocaleString() ?? "unavailable"} tokens</span></p>
      {!!value.max && value.used !== null && <progress value={Math.min(value.used, value.max)} max={value.max} aria-label="Recorded context usage" />}
      <p className="session-note">{value.used === null ? "Window usage is unavailable until the SDK reports it." : <>{value.estimated ? "Estimated reading; not an exact measure of session pressure." : "SDK-reported usage, as shown by tomo status."} Recorded {when(value.recordedAt)}.</>}</p>
      {!!value.breakdown.length && <dl className="facts">{value.breakdown.map((item) => <div key={item.name}><dt>{item.name}</dt><dd>{item.tokens.toLocaleString()} tokens</dd></div>)}</dl>}
    </section><section className="paper-section"><h2>Estimated composition</h2><p className="session-note">The same text estimate used by <code>tomo lcm stats</code>. This breakdown is separate from the reported window above.</p>
      {value.analysis ? <><p>{value.analysis.totalMessages.toLocaleString()} messages · {value.analysis.totalTokens.toLocaleString()} estimated tokens</p><div className="table-scroll"><table><thead><tr><th>Activity</th><th>Messages</th><th>Tokens</th><th>Time</th></tr></thead><tbody>{value.analysis.sections.map((section) => <tr key={section.id}><td>{section.type.replaceAll("_", " ")}</td><td>{section.messageCount}</td><td>{section.tokens.toLocaleString()}</td><td>{when(section.earliestAt)}</td></tr>)}</tbody></table></div>{value.analysis.truncated && <p className="session-note">Showing the latest 100 sections.</p>}</> : <p className="empty-note">{value.analysisStatus === "too_large" ? "This SDK transcript exceeds the 16 MiB analysis limit. Recorded window usage remains available." : "No SDK transcript is available for analysis yet."}</p>}
    </section><section className="paper-section"><h2>Rollup summaries</h2><p className="session-note">Summary blocks currently retained in the SDK transcript, as listed by <code>tomo lcm blocks</code>.</p>
      {!value.summaries.length && <p className="empty-note">No retained summaries available.</p>}
      {value.summaries.map((block, i) => <details key={`${block.tag}:${i}`}><summary>{block.tag} · {block.eventsSummarized} events · {when(block.timestamp)}</summary><div className="markdown"><Text>{block.content}</Text></div>{block.truncated && <p>Summary preview truncated.</p>}</details>)}
    </section><section className="paper-section"><h2>Recent compactions</h2><p className="session-note">Recent watch events from this daemon run. This is not a complete audit log.</p>
      {!value.recentCompactions.length && <p className="empty-note">No recent compaction events.</p>}
      {value.recentCompactions.map((event, i) => <p key={i}>{when(event.timestamp)} · {event.preTokens?.toLocaleString() ?? "—"} → {event.postTokens?.toLocaleString() ?? "—"} tokens</p>)}
    </section></>}
  </>;
}
