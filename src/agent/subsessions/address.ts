/**
 * `/s`: how the owner names a sub-session from their own chat.
 *
 * - `/s` lists the owner's sub-sessions.
 * - `/s <id>` shows one.
 * - `/s <id> stop` cancels it; `/s <id> start` starts a queued one past the
 *   slot cap; `/s <id> model <alias>` changes its model; `/s <id> done [n]`
 *   says the owner did what its report asked of them (`n`, the report
 *   number `/s <id>` showed them: a newer report's ask is not cleared by it).
 * - `/s <id> <anything else>` is a message to it.
 *
 * Only an EXACT match of what follows the id is a command (any case,
 * surrounding whitespace allowed). `/s s3 stop the deploy and roll back` is a
 * message, not a cancel: stop ends the task for good, so a near miss must
 * read as words, never as the command.
 *
 * Parsed in Agent.enqueueMessage for the owner's own DM only (never in a
 * channel, which does not yet know who sent it or whether it is a group).
 */

export type TaskAddress =
  | { kind: "list" }
  /** `/s <something>` where `<something>` is not a task id. */
  | { kind: "usage" }
  /** `/s trust`: the owner checked a task table recovered from its backup (SubsessionService.trust). */
  | { kind: "trust" }
  | { kind: "show"; id: string }
  | { kind: "stop"; id: string }
  | { kind: "start"; id: string }
  /** `report`: the report number the owner answered, when they gave one. */
  | { kind: "done"; id: string; report?: number }
  | { kind: "model"; id: string; model: string }
  | { kind: "message"; id: string; body: string };

const ADDRESS = /^\/s(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;
const TASK_ID = /^s[1-9]\d*$/i;

/**
 * Parse `text` as a `/s` address, or undefined when it is not one. `botUsername`
 * (Telegram): a `/s@OtherBot` is someone else's command and is left alone.
 */
export function parseTaskAddress(text: string, botUsername?: string): TaskAddress | undefined {
  const match = ADDRESS.exec(text.trim());
  if (!match) return undefined;
  if (match[1] !== undefined && botUsername !== undefined && match[1].toLowerCase() !== botUsername.toLowerCase()) return undefined;
  const rest = (match[2] ?? "").trim();
  if (!rest) return { kind: "list" };
  const space = rest.search(/\s/);
  const head = space === -1 ? rest : rest.slice(0, space);
  if (/^trust$/i.test(rest)) return { kind: "trust" };
  if (!TASK_ID.test(head)) return { kind: "usage" };
  const id = head.toLowerCase();
  const tail = space === -1 ? "" : rest.slice(space).trim();
  if (!tail) return { kind: "show", id };
  if (/^stop$/i.test(tail)) return { kind: "stop", id };
  if (/^start$/i.test(tail)) return { kind: "start", id };
  const done = /^done(?:\s+(\d{1,9}))?$/i.exec(tail);
  if (done) return done[1] !== undefined && Number(done[1]) > 0 ? { kind: "done", id, report: Number(done[1]) } : { kind: "done", id };
  const model = /^model\s+(\S+)$/i.exec(tail);
  if (model) return { kind: "model", id, model: model[1] };
  return { kind: "message", id, body: tail };
}

/** Does `text` start like a `/s` address? (Telegram: let it past the slash-command filter.) */
export function looksLikeTaskAddress(text: string): boolean {
  return /^\/s(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}
