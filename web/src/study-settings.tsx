import { useEffect, useState, type FormEvent } from "react";
import type { ConfigPreview, ConfigView, SafeField, WebManagement } from "../../src/web/management.js";
import type { WebMcpLiveSession } from "../../src/web/protocol.js";
import { api, ApiError, mutate } from "./api.js";
import type { WebState } from "./study.js";
import { Dialog, failure, FieldEditor, fieldInput, ResourceState, useResource } from "./study-ui.js";

function PreviewDialog({ preview, web, done, cancel, endpoint }: { preview: ConfigPreview; web: WebState; done(): void; cancel(): void; endpoint: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const apply = async () => {
    if (!web.bootstrap) return; setBusy(true); setError("");
    try { await mutate(endpoint, { id: preview.id }, web.bootstrap, web.refreshBootstrap); done(); }
    catch (error) { setError(failure(error)); } finally { setBusy(false); }
  };
  return <Dialog title="Review changes" busy={busy} cancel={cancel} confirm={() => void apply()} action="Save reviewed changes">
    <p>Only this reviewed proposal will be saved. A restart is required to apply these settings to the running daemon.</p>
    <div className="diff-list">{preview.diff.map((entry) => <section key={entry.field}><h3>{entry.field}</h3><div className="diff-pair"><div><span>Before</span><pre>{JSON.stringify(entry.before, null, 2)}</pre></div><div><span>After</span><pre>{JSON.stringify(entry.after, null, 2)}</pre></div></div></section>)}</div>
    {preview.webChange && <p className="notice">Changing the web port, origin, owner, or enabled state may change how you reconnect. Read the new private access link after restart.</p>}
    {error && <p className="notice" role="alert">{error}</p>}
  </Dialog>;
}
function RestartPanel({ revision, required, web }: { revision: string; required: boolean; web: WebState }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [reason, setReason] = useState("Apply settings reviewed in the web UI");
  const [message, setMessage] = useState(""); const [startingEpoch, setStartingEpoch] = useState<string>();
  const config = useResource<ConfigView>("/config", web.revision);
  useEffect(() => {
    if (startingEpoch && web.bootstrap?.epoch && startingEpoch !== web.bootstrap.epoch && web.connection === "live") {
      setMessage("Restart complete. Connected to the new daemon."); setStartingEpoch(undefined); config.reload();
    }
  }, [startingEpoch, web.bootstrap?.epoch, web.connection]);
  useEffect(() => {
    if (!startingEpoch || busy) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const status = await api<{ epoch: string; pending: boolean }>("/restart");
        if (!cancelled && status.epoch === startingEpoch && !status.pending) {
          setStartingEpoch(undefined);
          setMessage("Restart did not replace this daemon. Check Tomo’s logs, then retry when ready.");
          return;
        }
      } catch { /* A disconnect is expected; never automatically retry a restart. */ }
      if (!cancelled) timer = setTimeout(() => void check(), 2_000);
    };
    timer = setTimeout(() => void check(), 2_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [startingEpoch, busy]);
  const restart = async () => {
    if (!web.bootstrap || !reason.trim()) return;
    setBusy(true); setMessage(""); setStartingEpoch(web.bootstrap.epoch);
    try {
      await mutate("/restart", { revision, reason, confirm: true }, web.bootstrap, web.refreshBootstrap);
      setOpen(false); setMessage("Restart requested. Waiting for Tomo to reconnect…");
    } catch (error) {
      setMessage(failure(error));
      if (error instanceof ApiError) setStartingEpoch(undefined); // Definite rejection only.
      else setOpen(false);
    } finally { setBusy(false); }
  };
  const value = (path: string) => config.value?.fields.find((f) => f.label === path)?.value;
  return <section className="restart-panel" aria-label="Restart status"><div><strong>{required ? "Restart required" : "Saved configuration matches startup"}</strong><p>{message || "Settings are saved on disk. Restart through Tomo’s normal shutdown and startup path when ready."}</p></div><button disabled={!!startingEpoch || web.connection !== "live"} onClick={() => setOpen(true)}>Restart Tomo</button>
    {open && <Dialog title="Restart Tomo?" cancel={() => setOpen(false)} confirm={() => void restart()} busy={busy} action="Confirm restart">
      <p>Tomo will finish its shutdown sequence and restart. Messages may briefly be unavailable.</p>
      <p>Web listener after restart: {value("web.enabled") === false ? "disabled" : `127.0.0.1:${String(value("web.port") ?? 9465)}`}</p>
      {value("web.enabled") === false && <p className="notice">The UI will not reconnect. Re-enable it through the config file or CLI.</p>}
      <p>If the port or external origin changes, open the new private link in <code>web-access.log</code>.</p>
      <label htmlFor="restart-reason">Reason</label><input id="restart-reason" maxLength={240} value={reason} onChange={(e) => setReason(e.target.value)} />{message && <p role="alert">{message}</p>}
    </Dialog>}
  </section>;
}
function validationMessage(error: unknown): string {
  if (error instanceof ApiError) return failure(error) + (error.fields?.length ? ` Fields: ${error.fields.join(", ")}.` : "");
  return "Check the JSON, number, and boolean values. No changes were saved.";
}
export function ConfigPage({ web }: { web: WebState }) {
  const data = useResource<ConfigView>("/config", web.revision);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); const [preview, setPreview] = useState<ConfigPreview>();
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [filter, setFilter] = useState("");
  // Freeze the revision when editing begins, so an SSE refresh cannot silently
  // rebase a user's old field values onto someone else's newly saved config.
  const [baseRevision, setBaseRevision] = useState<string>();
  const change = (field: SafeField, value: string) => { setBaseRevision((old) => old ?? data.value?.revision); setDrafts((old) => ({ ...old, [field.label]: value })); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!data.value || !web.bootstrap || !Object.keys(drafts).length) return;
    setBusy(true); setNotice("");
    try {
      const changes = data.value.fields.filter((field) => drafts[field.label] !== undefined).map((field) => {
        const draft = drafts[field.label];
        return !field.secret && draft === "" ? { path: field.path, remove: true } : { path: field.path, value: fieldInput(field, draft) };
      });
      setPreview(await mutate<ConfigPreview>("/config/preview", { revision: baseRevision ?? data.value.revision, changes }, web.bootstrap, web.refreshBootstrap));
      setDrafts({}); setBaseRevision(undefined);
    } catch (error) { setNotice(validationMessage(error)); } finally { setBusy(false); }
  };
  const visible = data.value?.fields.filter((field) => field.label.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const groups = [...new Set(visible.map((field) => field.path[0]))];
  return <><ResourceState {...data} retry={data.reload} />{data.value && <>
    <RestartPanel revision={data.value.revision} required={data.value.restartRequired} web={web} />
    <div className="page-toolbar"><label className="sr-only" htmlFor="config-filter">Find a setting</label><input id="config-filter" type="search" placeholder="Find a setting…" value={filter} onChange={(e) => setFilter(e.target.value)} /><button onClick={() => { data.reload(); setDrafts({}); setBaseRevision(undefined); }}>Reload settings</button></div>
    <p className="session-note">Blank unchanged fields keep their saved value. Empty edited non-secret fields use the default. Secrets and opaque extension values show only Set or Unset; supply a replacement to change them.</p>
    {notice && <p className="notice" role="alert">{notice}</p>}
    <form onSubmit={(e) => void submit(e)} className="settings-form">
      {groups.map((group) => <details className="settings-group" key={group} open={filter ? true : undefined}><summary>{group}<span>{visible.filter((field) => field.path[0] === group).length} {visible.filter((field) => field.path[0] === group).length === 1 ? "field" : "fields"}</span></summary><div className="field-grid">{visible.filter((field) => field.path[0] === group).map((field) => <FieldEditor key={field.label} field={field} draft={drafts[field.label]} change={(value) => change(field, value)} />)}</div></details>)}
      <div className="save-bar"><span>{Object.keys(drafts).length} edited fields</span><button className="primary" type="submit" disabled={busy || !Object.keys(drafts).length || web.connection !== "live"}>{busy ? "Validating…" : "Preview config changes"}</button></div>
    </form>
    {preview && <PreviewDialog preview={preview} web={web} endpoint="/config/apply" cancel={() => setPreview(undefined)} done={() => { setPreview(undefined); setNotice("Configuration saved. Restart required."); data.reload(); }} />}
  </>}</>;
}
export function McpPage({ web }: { web: WebState }) {
  type McpData = ReturnType<WebManagement["mcp"]> & { live: { sessions: WebMcpLiveSession[]; available: boolean } };
  const data = useResource<McpData>("/mcp", web.revision);
  const schema = useResource<ReturnType<WebManagement["schema"]>>("/config/schema", 0);
  const [editing, setEditing] = useState<{ name: string; isNew: boolean; fields: SafeField[]; revision: string }>();
  const [name, setName] = useState(""); const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ConfigPreview>(); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const propose = async (input: unknown) => {
    if (!web.bootstrap) return; setBusy(true); setNotice("");
    try { setPreview(await mutate<ConfigPreview>("/mcp/preview", input, web.bootstrap, web.refreshBootstrap)); setEditing(undefined); setDrafts({}); }
    catch (error) { setNotice(validationMessage(error)); } finally { setBusy(false); }
  };
  const saveServer = async (event: FormEvent) => {
    event.preventDefault(); if (!editing) return;
    try {
      const values = Object.fromEntries(editing.fields.filter((field) => drafts[field.path[0]] !== undefined).map((field) => [field.path[0], fieldInput(field, drafts[field.path[0]])]));
      await propose({ revision: editing.revision, name: editing.isNew ? name : editing.name, operation: "save", values });
    } catch (error) { setNotice(validationMessage(error)); }
  };
  useEffect(() => { const timer = setInterval(data.reload, 15_000); return () => clearInterval(timer); }, []);
  return <><div className="page-toolbar"><span>Connections refresh every 15 seconds</span><div className="row-actions"><button onClick={data.reload}>Refresh servers</button><button className="primary" disabled={!schema.value || !data.value} onClick={() => { setNotice(""); setName(""); setDrafts({ type: "stdio" }); setEditing({ name: "", isNew: true, fields: schema.value!.mcpFields.map((field) => ({ ...field, set: false })), revision: data.value!.revision }); }}>Add server</button></div></div>
    <ResourceState {...data} retry={data.reload} />{notice && <p className="notice" role="alert">{notice}</p>}
    {data.value && <><RestartPanel revision={data.value.revision} required={data.value.restartRequired} web={web} />
      {!data.value.live.available && <p className="notice">Live status is unavailable. Saved configuration is shown below.</p>}
      {!data.value.servers.length && <p className="empty-note">No external MCP servers configured.</p>}
      {data.value.servers.map((server) => <article className="paper-section" key={server.name}><div className="section-top"><h2>{server.name}</h2><span className="scope">{server.enabled ? "Enabled in config" : "Disabled in config"}</span></div>
        <p className="session-note">Saved transport: {String(server.fields.find((field) => field.path[0] === "type")?.value ?? "stdio")}</p>
        {!data.value!.live.sessions.length ? <p>No active SDK sessions. Connection status is unknown.</p> : <ul className="connection-list">{data.value!.live.sessions.map((session) => <li key={session.sessionId}><span>{web.bootstrap?.sessions.find((item) => item.id === session.sessionId)?.title ?? "Conversation"}</span><strong>{session.connections === null ? "Unknown" : session.connections.find((item) => item.name === server.name)?.status ?? "Not mounted"}</strong></li>)}</ul>}
        <div className="row-actions"><button onClick={() => { setNotice(""); setEditing({ ...server, isNew: false, revision: data.value!.revision }); setDrafts({}); }}>Edit {server.name}</button><button disabled={busy} onClick={() => void propose({ revision: data.value!.revision, name: server.name, operation: "enable", enabled: !server.enabled })}>{server.enabled ? "Disable" : "Enable"}</button><button disabled={busy} onClick={() => void propose({ revision: data.value!.revision, name: server.name, operation: "remove" })}>Remove</button></div>
      </article>)}
    </>}
    {editing && <section className="paper-section server-editor"><div className="section-top"><h2>{editing.isNew ? "New MCP server" : `Edit ${editing.name}`}</h2><button onClick={() => { setEditing(undefined); setDrafts({}); }}>Cancel edit</button></div><p className="session-note">Connection details may contain credentials and remain hidden. Leave fields unchanged to preserve them. No connection is started by this editor.</p>
      <form onSubmit={(e) => void saveServer(e)}>{editing.isNew && <div className="config-field"><label htmlFor="server-name">Server name</label><input id="server-name" required pattern="[A-Za-z0-9._-]{1,128}" value={name} onChange={(e) => setName(e.target.value)} /></div>}
        <div className="field-grid">{editing.fields.filter((field) => !["enabled", "disabled"].includes(field.path[0])).map((field) => <FieldEditor key={field.label} field={field} draft={drafts[field.path[0]]} change={(value) => setDrafts((old) => ({ ...old, [field.path[0]]: value }))} />)}</div>
        <button className="primary" type="submit" disabled={busy || web.connection !== "live"}>{busy ? "Validating…" : "Preview server changes"}</button>
      </form>
    </section>}
    {preview && <PreviewDialog preview={preview} web={web} endpoint="/mcp/apply" cancel={() => setPreview(undefined)} done={() => { setPreview(undefined); setNotice("MCP configuration saved. Restart required."); data.reload(); }} />}
  </>;
}
