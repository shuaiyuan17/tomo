import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, submitCredential, type WebBootstrap } from "./api.js";
import { useAgentName } from "./agent-name.js";
import { Button } from "@/components/ui/button";
import type { WebCredentialRequest } from "../../src/web/protocol.js";

/** What the card says when the daemon refuses an answer (fixed codes only: no response echoes the value). */
export function credentialError(code: string): string {
  if (code === "credential_expired") return "This request expired. Ask again in the chat if it is still needed.";
  if (code === "credential_unknown") return "This request is no longer open.";
  if (code === "invalid_value") return "Not stored: it needs plain text (printable ASCII), 4 to 8192 characters.";
  if (code === "epoch_changed") return "Tomo restarted. Ask again in the chat.";
  if (code === "credential_store_unavailable") return "Not stored: the keychain is unavailable.";
  return "Could not send. Try again.";
}

/** Whole minutes and seconds left, for the card's countdown. */
export function timeLeft(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The credential broker's password card. The value is read from the field
 * (never React state, never a message view), the field is cleared before the
 * request leaves, and it goes to POST /credentials/<id>, never /messages: no
 * chat bubble, no request journal, no transcript. The card goes when the
 * daemon withdraws the request (the `credential-request` event).
 */
export function CredentialCard({ request, bootstrap, refresh }: { request: WebCredentialRequest; bootstrap?: WebBootstrap; refresh: () => Promise<WebBootstrap> }) {
  const agent = useAgentName();
  const field = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setError(""); setBusy(false); field.current?.focus(); }, [request.id]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, []);
  // Whatever happens, the field never outlives the card.
  useEffect(() => () => { if (field.current) field.current.value = ""; }, []);

  const answer = async (input: { value: string } | { cancel: true }) => {
    if (!bootstrap || busy) return;
    setBusy(true); setError("");
    try { await submitCredential(request.id, input, bootstrap, refresh); }
    catch (err) { setError(credentialError(err instanceof ApiError ? err.code : "")); }
    finally { setBusy(false); }
  };
  const store = (event: FormEvent) => {
    event.preventDefault();
    const value = field.current?.value ?? "";
    if (field.current) field.current.value = "";
    if (!value) return;
    void answer({ value });
  };
  return <form onSubmit={store} role="dialog" aria-modal="false" aria-labelledby="credential-title" data-testid="credential-card"
    className="motion-enter mb-2 rounded-2xl border bg-card px-4 py-3 shadow-sm">
    <div className="flex items-center gap-2">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      <h2 id="credential-title" className="m-0 text-[13px] font-medium">{agent} is asking for a credential: <code>{request.name}</code></h2>
      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" aria-label="Time left">{timeLeft(request.expiresAt, now)}</span>
    </div>
    <p className="mt-1 mb-2.5 text-[12.5px] leading-snug text-muted-foreground">
      <span className="text-foreground/80">{request.purpose}</span> <span className="whitespace-nowrap">(written by {agent}, not verified)</span>.
      It goes to the keychain, not the chat, and {agent} never sees it.</p>
    <div className="flex items-center gap-2">
      <input ref={field} type="password" name="credential-value" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        aria-label={`Value for ${request.name}`} disabled={busy}
        className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
      <Button type="submit" size="sm" className="h-9 rounded-lg" disabled={busy}>Store</Button>
      <Button type="button" variant="ghost" size="sm" className="h-9 rounded-lg" disabled={busy} onClick={() => { if (field.current) field.current.value = ""; void answer({ cancel: true }); }}>Refuse</Button>
    </div>
    {error && <p role="status" className="m-0 mt-2 text-[12px] text-destructive">{error}</p>}
  </form>;
}
