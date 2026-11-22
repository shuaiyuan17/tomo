import { isRawJsonlLine } from "../jsonl.js";

/**
 * The ids under which the SDK's loader (`getSessionMessages`) shows the
 * events of a session file, aligned with `events` (undefined for a raw line
 * or an event without a uuid).
 *
 * Usually an event's own `uuid`. The exception is a `type:"attachment"` event
 * with `attachment.type:"queued_command"` (a message delivered mid-turn): the
 * loader turns it into a user message whose uuid is `attachment.source_uuid`.
 *
 * Mirrors @anthropic-ai/claude-agent-sdk 0.3.329, sdk.mjs: `KT` → `zMe`
 * (attachment → user conversion) → `K$` (`uuid: source_uuid || e.uuid`),
 * then `$Me` (which messages are returned). An attachment is mapped to its
 * source_uuid only when every per-event condition there holds:
 *   - `attachment.type === "queued_command"`;
 *   - `prompt` is a string or an array;
 *   - not `isMeta`, unless its `origin` is one `UT` keeps (getSessionMessages
 *     passes `keepMeta: false`, and `$Me` drops such a meta message anyway);
 *   - no `forwardedIntent` with a non-empty `lineage` (`j$`/`bLe`: those are
 *     never converted);
 *   - `source_uuid` is a non-empty string;
 *   - `source_uuid` is not the uuid of another event, nor already taken by an
 *     earlier converted attachment (`n.has(a.uuid)`: the loader then leaves
 *     the attachment as is).
 * Anything else keeps its own uuid. An attachment that is not converted is
 * not shown at all, so its id only matters if it were shared — and the rules
 * above leave a source_uuid to at most one event.
 *
 * Not mirrored: `zMe`'s positional gate (`t`: converted only when a reply
 * follows it on the chain, it was delivered, or it trails the chain). An
 * eligible attachment the loader does not convert for that reason keeps its
 * source_uuid here; that id is unique, never on the loader's chain, and so
 * cannot mask or be mistaken for another event.
 *
 * Re-check this when upgrading the SDK; tests/lcm-chain-contract.test.ts
 * pins it against the installed loader.
 */
export function loaderVisibleIds(events: readonly unknown[]): (string | undefined)[] {
  const ownUuids = new Set<string>();
  for (const e of events) {
    const uuid = asEvent(e)?.uuid;
    if (typeof uuid === "string" && uuid) ownUuids.add(uuid);
  }
  const taken = new Set<string>();
  return events.map((entry) => {
    const e = asEvent(entry);
    if (!e) return undefined;
    const own = typeof e.uuid === "string" && e.uuid ? e.uuid : undefined;
    const source = convertedSourceUuid(e);
    if (source === undefined || source === own) return own;
    if (ownUuids.has(source) || taken.has(source)) return own;
    taken.add(source);
    return source;
  });
}

type FileEvent = { uuid?: unknown; type?: unknown; attachment?: unknown };

function asEvent(entry: unknown): FileEvent | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry) || isRawJsonlLine(entry)) return undefined;
  return entry as FileEvent;
}

/** The source_uuid if `zMe`/`K$` would convert this event (positional gate aside), else undefined. */
function convertedSourceUuid(e: FileEvent): string | undefined {
  if (e.type !== "attachment" || typeof e.attachment !== "object" || e.attachment === null) return undefined;
  const a = e.attachment as Record<string, unknown>;
  if (a.type !== "queued_command") return undefined;
  if (typeof a.prompt !== "string" && !Array.isArray(a.prompt)) return undefined;
  if (Boolean(a.isMeta) && !keptMetaOrigin(a.origin)) return undefined;
  if (hasForwardedIntent(a.forwardedIntent)) return undefined;
  return typeof a.source_uuid === "string" && a.source_uuid ? a.source_uuid : undefined;
}

/** `UT(Q$(origin))`: RLe with udsInboxEnabled. */
function keptMetaOrigin(origin: unknown): boolean {
  if (typeof origin !== "object" || origin === null) return false;
  const o = origin as { kind?: unknown };
  if (typeof o.kind !== "string") return false;
  return ["channel", "observer", "observer-activity", "slack-ping", "voice-call", "peer"].includes(o.kind);
}

/** `bLe(forwardedIntent) !== undefined`: an object with a non-empty string `lineage`. */
function hasForwardedIntent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lineage = (value as { lineage?: unknown }).lineage;
  return typeof lineage === "string" && lineage.length > 0;
}

/**
 * Loader-visible ids of the events a rewrite removes, decided per file event
 * of the snapshot. An id that some removed event and some kept event share
 * (only possible for a duplicated uuid) counts as removed: the loader's
 * output cannot tell the two apart, and refusing beats missing a removed
 * event that is still on the chain.
 */
export function removedLoaderIds(events: readonly unknown[], removed: (index: number) => boolean): Set<string> {
  const out = new Set<string>();
  loaderVisibleIds(events).forEach((id, i) => { if (id !== undefined && removed(i)) out.add(id); });
  return out;
}
