import {
  appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { errorMessage } from "../error-text.js";
import { getSdkSessionPath } from "../sessions/index.js";
import {
  compactSessionCapturing, getCompactTriggerPath,
  type CompactRequest, type CompactResult, type RewriteCapture,
} from "./compact.js";

/**
 * Post-rewrite chain check: after LCM rewrites a session file, ask the SDK's
 * own loader (`getSessionMessages`, the public reader that rebuilds the
 * parentUuid chain the agent will resume on) whether the result is still one
 * intact conversation, and put the pre-rewrite file back if it is not.
 *
 * Why the SDK and not our own parser: the failure this guards against is the
 * SDK reading the file differently from how we wrote it. A summary whose
 * parent link the loader does not follow, or a successor still pointing at a
 * removed uuid, makes the loader start the chain somewhere later and silently
 * drop everything before it — the summary blocks included. Only the loader
 * can say what it will load, and it says so the same way after an SDK upgrade
 * changes the format (tests/lcm-chain-contract.test.ts pins this).
 *
 * What "intact" means, comparing the loader's chain before and after:
 *   - the new summary block is on the chain;
 *   - no removed event is still on it;
 *   - every event that was on the chain and was not removed still is, in the
 *     same order — the older blocks before the summary, the fresh tail after
 *     it (a missing one is an orphaned segment).
 * Events the SDK appended in between (a live turn keeps writing) are allowed.
 */

export interface ChainCheckOptions {
  /**
   * The project working directory the SDK resolves the session under
   * (`getSessionMessages`'s `dir`): Tomo's workspace.
   */
  workspaceDir: string;
  /** @internal Test seam: the loader to check with. Defaults to the SDK's. */
  loadChain?: (sessionId: string, dir: string) => Promise<SessionMessage[]>;
}

export interface ChainVerdict {
  ok: boolean;
  problems: string[];
  /** Kept chain events expected after the summary (the fresh tail), and how many the loader still returns. */
  tailExpected: number;
  tailFound: number;
}

const sdkLoadChain = (sessionId: string, dir: string) => getSessionMessages(sessionId, { dir });

/**
 * Compare the loader's chain after a rewrite with the chain before it.
 * Pure, exported for tests.
 */
export function checkRewrittenChain(args: {
  before: readonly string[];
  after: readonly string[];
  summaryUuid: string;
  removedUuids: ReadonlySet<string>;
}): ChainVerdict {
  const { before, after, summaryUuid, removedUuids } = args;
  const problems: string[] = [];
  const position = new Map<string, number>();
  after.forEach((uuid, i) => { if (!position.has(uuid)) position.set(uuid, i); });

  const firstRemoved = before.findIndex((uuid) => removedUuids.has(uuid));
  // Nothing removed was on the chain (a range entirely off the main branch):
  // there is no position the summary must hold, only the survivors to check.
  const rangeOnChain = firstRemoved >= 0;
  const summaryAt = position.get(summaryUuid);
  if (rangeOnChain && summaryAt === undefined) problems.push("summary block is not on the loaded chain");

  const stillThere = after.filter((uuid) => removedUuids.has(uuid));
  if (stillThere.length > 0) problems.push(`${stillThere.length} removed event(s) still on the chain`);

  const head = rangeOnChain ? before.slice(0, firstRemoved) : [];
  const tail = (rangeOnChain ? before.slice(firstRemoved) : before).filter((uuid) => !removedUuids.has(uuid));

  const missingHead = head.filter((uuid) => !position.has(uuid));
  if (missingHead.length > 0) problems.push(`${missingHead.length} event(s) before the summary dropped off the chain`);
  const tailFound = tail.filter((uuid) => position.has(uuid)).length;
  if (tailFound < tail.length) problems.push(`fresh tail broken: ${tailFound}/${tail.length} event(s) still on the chain`);

  let last = -1;
  let outOfOrder = false;
  for (const uuid of [...head, ...(summaryAt === undefined ? [] : [summaryUuid]), ...tail]) {
    const at = position.get(uuid);
    if (at === undefined) continue;
    if (at <= last) outOfOrder = true;
    last = at;
  }
  if (outOfOrder) problems.push("surviving events are out of their original order");

  return { ok: problems.length === 0, problems, tailExpected: tail.length, tailFound };
}

/**
 * `compactSession`, then verify the published file with the SDK's loader and
 * roll back to the pre-rewrite file when the chain is broken.
 *
 * On the happy path the session file is exactly what `compactSession` writes.
 * When the loader cannot see the session at all before the rewrite (a session
 * id it does not accept, a workspace it resolves elsewhere), there is nothing
 * to compare against: the rewrite runs unchecked, as it did before, with a
 * warning.
 */
export async function compactSessionChecked(req: CompactRequest, opts: ChainCheckOptions): Promise<CompactResult> {
  const loadChain = opts.loadChain ?? sdkLoadChain;
  let before: string[] | undefined;
  try {
    before = (await loadChain(req.sdkSessionId, opts.workspaceDir)).map((m) => m.uuid);
  } catch (err) {
    log.warn({ err, sessionId: req.sdkSessionId }, "Chain check unavailable: the SDK could not load the session before the rewrite");
  }
  if (!before || before.length === 0) {
    if (before) log.warn({ sessionId: req.sdkSessionId }, "Chain check unavailable: the SDK loader sees no messages for this session");
    return compactSessionCapturing(req);
  }

  const capture: RewriteCapture = { published: false };
  const result = compactSessionCapturing(req, capture);
  if (!result.success || !capture.published || !capture.backupPath) return result;
  const backupPath = capture.backupPath;

  const startedAt = performance.now();
  let verdict: ChainVerdict;
  try {
    const after = (await loadChain(req.sdkSessionId, opts.workspaceDir)).map((m) => m.uuid);
    verdict = checkRewrittenChain({
      before, after, summaryUuid: capture.summaryUuid!, removedUuids: capture.removedUuids!,
    });
  } catch (err) {
    verdict = { ok: false, problems: [`SDK loader threw: ${errorMessage(err)}`], tailExpected: 0, tailFound: 0 };
  }
  const checkMs = Math.round(performance.now() - startedAt);

  if (verdict.ok) {
    try { unlinkSync(backupPath); } catch { /* swept as a staging corpse later */ }
    log.info({ sessionId: req.sdkSessionId, checkMs, tail: verdict.tailExpected }, "Rewrite chain check passed");
    return result;
  }

  const rolledBack = rollBack(req, capture as Required<RewriteCapture>);
  log.error({
    sessionId: req.sdkSessionId,
    problems: verdict.problems,
    tailExpected: verdict.tailExpected,
    tailFound: verdict.tailFound,
    rolledBack: rolledBack.ok,
    rollbackError: rolledBack.error,
    checkMs,
  }, "Rewrite chain check failed: the SDK loader does not see an intact chain");
  return {
    success: false,
    eventsRemoved: 0,
    eventsAfter: result.eventsAfter,
    error: `Chain check failed after the rewrite (${verdict.problems.join("; ")}). ` +
      (rolledBack.ok
        ? "The session file was restored to its pre-rewrite state; the removed events stay in the archive, which a retry does not duplicate."
        : `Could not restore the pre-rewrite file: ${rolledBack.error}. The pre-rewrite copy is at ${backupPath}.`),
  };
}

/**
 * Put the pre-rewrite inode back at the session path.
 *
 * Lines the SDK appended to the published file after the rewrite (a live turn
 * keeps writing) are carried onto the backup first: they were written against
 * the SDK's in-memory chain, which is the pre-rewrite one, so they belong
 * there. Then the rename swaps the backup in atomically and the reload
 * trigger this rewrite wrote is withdrawn — the in-memory session already
 * matches the restored file. Refuses when the published file is no longer the
 * one this rewrite published (another rewriter got there first).
 */
function rollBack(req: CompactRequest, capture: Required<RewriteCapture>): { ok: boolean; error?: string } {
  const path = getSdkSessionPath(req.sdkSessionId, req.sdkSessionsDir);
  try {
    if (statSync(path).ino !== capture.publishedIno) {
      return { ok: false, error: "the session file was replaced again after the rewrite" };
    }
    const appended = readCompleteLinesFrom(path, capture.publishedSize);
    if (appended.length > 0) appendFileSync(capture.backupPath, appended);
    renameSync(capture.backupPath, path);
    if (!capture.triggerExisted) {
      const trigger = getCompactTriggerPath(req.sdkSessionId, req.sdkSessionsDir);
      if (existsSync(trigger)) unlinkSync(trigger);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function readCompleteLinesFrom(path: string, offset: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - offset);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, offset + total);
      if (n === 0) break;
      total += n;
    }
    const lastNl = buf.subarray(0, total).lastIndexOf(0x0A);
    return lastNl < 0 ? Buffer.alloc(0) : buf.subarray(0, lastNl + 1);
  } finally {
    closeSync(fd);
  }
}
