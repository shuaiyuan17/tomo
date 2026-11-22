import { isRawJsonlLine } from "../jsonl.js";

/**
 * The id under which the SDK's loader (`getSessionMessages`) shows a file
 * event. Usually its own `uuid`, but not always: a `type:"attachment"` event
 * whose `attachment.type` is `"queued_command"` (a message delivered mid-turn)
 * is turned into a user message whose uuid is `attachment.source_uuid` when
 * that is a non-empty string.
 *
 * Mirrors @anthropic-ai/claude-agent-sdk 0.3.329, sdk.mjs: `zMe` (the
 * attachment → user conversion in the session loader) via `K$`
 * (`uuid: source_uuid || e.uuid`). Re-check this when upgrading the SDK;
 * tests/lcm-chain-contract.test.ts pins it against the installed loader.
 */
export function loaderVisibleId(event: { uuid?: unknown; type?: unknown; attachment?: unknown }): string | undefined {
  if (event.type === "attachment" && typeof event.attachment === "object" && event.attachment !== null) {
    const att = event.attachment as { type?: unknown; source_uuid?: unknown };
    if (att.type === "queued_command" && typeof att.source_uuid === "string" && att.source_uuid) return att.source_uuid;
  }
  return typeof event.uuid === "string" && event.uuid ? event.uuid : undefined;
}

/**
 * Loader-visible ids of the events a rewrite removes, decided per file event
 * of the snapshot: an id is removed when every file event that the loader can
 * show under it is removed. (The loader skips a queued_command whose
 * source_uuid another event already uses; such an id then still belongs to a
 * kept event and is not counted as removed.)
 */
export function removedLoaderIds(
  events: readonly unknown[],
  removed: (index: number) => boolean,
): Set<string> {
  const byId = new Map<string, number[]>();
  events.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || isRawJsonlLine(entry)) return;
    const id = loaderVisibleId(entry);
    if (id === undefined) return;
    const list = byId.get(id);
    if (list) list.push(i); else byId.set(id, [i]);
  });
  const out = new Set<string>();
  for (const [id, indices] of byId) if (indices.every(removed)) out.add(id);
  return out;
}
