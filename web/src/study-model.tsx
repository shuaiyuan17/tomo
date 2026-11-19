import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import type { WebModelChangeResult, WebModelView, WebSession } from "../../src/web/protocol.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAgentName } from "./agent-name.js";
import { ApiError, mutate } from "./api.js";
import { modelErrorRefreshes, modelErrorText, pickTarget, switchCopy } from "./model-picker.js";
import { useResource } from "./study-data.js";
import { card, Empty, meta, Status, type Mutator } from "./study-ui.js";

type ModelRef = { id: string; label: string };

/**
 * The selected conversation's model, and (owner conversation only) a switch:
 * pick a listed model or type an id, confirm, and the next message runs on
 * it. The confirm is inline, not a Radix dialog: a modal overlay injects a
 * style the CSP refuses.
 */
export function ModelPage({ session, reload, mutator }: { session?: WebSession; reload: number; mutator: Mutator }) {
  const agent = useAgentName();
  const [resource, refetch] = useResource<WebModelView>(session ? `/models?session=${encodeURIComponent(session.id)}` : null, reload);
  const [target, setTarget] = useState<ModelRef | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WebModelChangeResult | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setTarget(null); setResult(null); setError(""); setDraft(""); }, [session?.id]);
  useEffect(() => { if (target) confirmButton.current?.focus(); }, [target]);
  if (!session) return <Empty>Choose a conversation in the sidebar.</Empty>;
  // A view still loaded for the previously selected conversation is not shown as this one's.
  const view = resource.state === "ready" && resource.value.sessionId === session.id ? resource.value : undefined;
  if (!view) return <Status resource={resource.state === "ready" ? { state: "loading" } : resource} />;
  const canSwitch = view.writable && mutator.live && !!mutator.bootstrap;
  const choose = (next: ModelRef) => { setResult(null); setError(""); setTarget(next); };
  const cancel = () => { if (!busy) { setTarget(null); setError(""); } };
  const confirm = async () => {
    if (!target || !mutator.bootstrap) return;
    setBusy(true); setError("");
    try {
      const value = await mutate<WebModelChangeResult>("/models", "POST",
        { sessionId: view.sessionId, model: target.id, from: view.model.id, confirm: true }, mutator.bootstrap, mutator.refresh);
      setResult(value); setTarget(null); setDraft(""); refetch();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unavailable";
      setError(modelErrorText(code, agent));
      if (modelErrorRefreshes(code)) refetch();
    } finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = pickTarget(view, draft);
    if (next) choose(next);
  };
  const copy = target ? switchCopy(view.model, target) : undefined;
  return <div className="space-y-5">
    <section className={cn(card, "px-6 py-5")} aria-labelledby="model-current">
      <p className="eyebrow" id="model-current">Model · {session.title}</p>
      <p className="mt-2 mb-1 text-2xl">{view.model.label}</p>
      <p className="m-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.model.id}</p>
      <p className="mt-3 mb-0 text-[13px] text-muted-foreground">{view.overridden
        ? `Chosen for this conversation. Without that choice it would use the default, ${view.defaultModel.label}.`
        : "The default from config.json."}</p>
      {view.busy && view.writable && <p className={cn(meta, "mt-2 mb-0")}>{agent} is replying right now. A switch can be made once the reply has finished.</p>}
      {!view.writable && <p className={cn(meta, "mt-2 mb-0")}>Groups are read-only here. To change a group's model, send /model in that group.</p>}
      {view.writable && !mutator.live && <p className={cn(meta, "mt-2 mb-0")}>Switching is available while connected.</p>}
      {result && <p className="mt-3 mb-0 text-[13px]" role="status">{result.status === "switched"
        ? `Switched from ${result.previous.label} to ${result.model.label}. The next message runs on it.`
        : `Already on ${result.model.label}; nothing changed.`}</p>}
    </section>

    {target && copy && <section role="group" aria-labelledby="model-confirm-title" className={cn(card, "rounded-2xl px-6 py-5")}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
      <h2 id="model-confirm-title" className="mt-0 mb-2 font-serif text-[22px] leading-snug font-normal">{copy.title}</h2>
      <p className="mt-0 mb-3 text-[13px] leading-relaxed text-muted-foreground">{copy.body}</p>
      <dl className="m-0 grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl bg-muted px-4 py-3 text-[13px]">
        <dt className={meta}>From</dt><dd className="m-0">{view.model.label} <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.model.id}</span></dd>
        <dt className={meta}>To</dt><dd className="m-0">{target.label === target.id ? <span className="font-mono text-xs [overflow-wrap:anywhere]">{target.id}</span>
          : <>{target.label} <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{target.id}</span></>}</dd>
      </dl>
      {error && <p className="mt-3 mb-0 text-[13px] text-destructive" role="alert">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" className="rounded-xl" disabled={busy} onClick={cancel}>Cancel</Button>
        <Button ref={confirmButton} className="rounded-xl" disabled={busy || !!error || !canSwitch} onClick={() => void confirm()}>{busy ? "Switching…" : "Switch model"}</Button>
      </div>
    </section>}

    <section className={cn(card, "px-6 py-5")} aria-labelledby="model-options">
      <p className="eyebrow mb-2" id="model-options">Models</p>
      <ul className="m-0 list-none divide-y p-0">{view.options.map((option) => {
        const active = option.id === view.model.id;
        return <li key={option.id}>
          <button type="button" disabled={!canSwitch || active || busy} aria-current={active ? "true" : undefined}
            onClick={() => choose({ id: option.id, label: option.label })}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto_20px] items-center gap-3 rounded-lg px-2 py-2.5 text-left text-[13px] enabled:hover:bg-foreground/[0.05] disabled:cursor-default max-[600px]:grid-cols-[minmax(0,1fr)_20px]">
            <span className="min-w-0"><span className="block truncate">{option.label}</span>
              <span className={meta}>{option.aliases.join(" · ")}</span></span>
            <span className="font-mono text-xs text-muted-foreground max-[600px]:hidden">{option.id}</span>
            <span className="flex justify-end">{active && <Check className="size-4 text-primary" strokeWidth={2} aria-label="Active" />}</span>
          </button></li>;
      })}</ul>
      {view.writable && <form onSubmit={submit} className="mt-4 border-t pt-4">
        <label htmlFor="model-other" className="mb-1.5 block text-[13px]">Another model</label>
        <div className="flex gap-2">
          {/* text-base below md: a focused input under 16px makes iOS Safari zoom the page. */}
          <Input id="model-other" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={200} autoComplete="off" spellCheck={false}
            placeholder="Model id, e.g. claude-opus-4-8" disabled={!canSwitch || busy} className="h-10 rounded-xl bg-card font-mono" />
          <Button type="submit" variant="outline" className="h-10 rounded-xl" disabled={!canSwitch || busy || !draft.trim()}>Switch…</Button>
        </div>
        <p className={cn(meta, "mt-2 mb-0")}>{view.gateway.configured
          ? view.gateway.chatgptOnly ? `The LiteLLM gateway routes chatgpt/* models only, e.g. ${view.gateway.example}.`
            : `LiteLLM provider/model names are accepted too, e.g. ${view.gateway.example}.`
          : "Any direct Claude model id is accepted; it is checked before anything is saved."}</p>
      </form>}
    </section>
  </div>;
}
