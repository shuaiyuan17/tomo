import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";
import { errorMessage } from "../error-text.js";
import { compactSessionGated, type CompactRequest, type CompactResult, type StagedRewrite } from "./compact.js";

/**
 * Pre-publish chain check: before LCM replaces a session file, ask the SDK's
 * own loader (`getSessionMessages`, the public reader that rebuilds the
 * parentUuid chain the agent will resume on) whether the rewritten file is
 * still one intact conversation. Only a rewrite that passes is published.
 *
 * Why the SDK and not our own parser: the failure this guards against is the
 * SDK reading the file differently from how we wrote it. A summary whose
 * parent link the loader does not follow, or a successor still pointing at a
 * removed uuid, makes the loader start the chain somewhere later and silently
 * drop everything before it — the summary blocks included. Only the loader
 * can say what it will load, and it says so the same way after an SDK upgrade
 * changes the format (tests/lcm-chain-contract.test.ts pins this).
 *
 * How: the staged rewrite is written, under the same session id, into a
 * throwaway project directory next to the real one — the layout the SDK
 * resolves a `dir` to — and loaded from there. The real session file is not
 * touched until the check has passed.
 *
 * What "intact" means, comparing the loader's chain of the live file with the
 * chain of the staged copy:
 *   - the new summary block is on the chain;
 *   - no removed event is still on it;
 *   - every event that was on the chain and was not removed still is, in the
 *     same order — the older blocks before the summary, the fresh tail after
 *     it (a missing one is an orphaned segment).
 * Events the SDK appended between the first read and the snapshot are allowed.
 *
 * Fail closed: when either read throws or comes back empty, or the range is
 * not on the current chain at all, the rewrite is refused. An unverifiable
 * rewrite is not published.
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

/** Suffix of the throwaway workspace path / project directory a staged rewrite is loaded from. */
const VERIFY_MARK = "-lcm-verify-";
/** A verify dir is `<project dir>-lcm-verify-<32 hex>` holding this marker; nothing else is ever swept. */
const VERIFY_MARKER_FILE = ".tomo-lcm-verify";
const VERIFY_SUFFIX_RE = /^-lcm-verify-[0-9a-f]{32}$/;
const VERIFY_DIR_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Compare the loader's chain of the rewritten file with the chain before it.
 * Pure, exported for tests.
 */
export function checkRewrittenChain(args: {
  before: readonly string[];
  after: readonly string[];
  summaryUuid: string;
  /**
   * Loader-visible ids of the removed events (`removedLoaderIds`), not file
   * uuids: the loader shows a queued_command attachment under its
   * source_uuid, and `before`/`after` are the loader's ids.
   */
  removedIds: ReadonlySet<string>;
}): ChainVerdict {
  const { before, after, summaryUuid, removedIds } = args;
  const problems: string[] = [];
  const position = new Map<string, number>();
  after.forEach((uuid, i) => { if (!position.has(uuid)) position.set(uuid, i); });

  const firstRemoved = before.findIndex((uuid) => removedIds.has(uuid));
  if (firstRemoved < 0) problems.push("the selected range is not on the current chain");
  const summaryAt = position.get(summaryUuid);
  if (summaryAt === undefined) problems.push("summary block is not on the loaded chain");

  const stillThere = after.filter((uuid) => removedIds.has(uuid));
  if (stillThere.length > 0) problems.push(`${stillThere.length} removed event(s) still on the chain`);

  const head = firstRemoved < 0 ? [] : before.slice(0, firstRemoved);
  const tail = (firstRemoved < 0 ? before : before.slice(firstRemoved)).filter((uuid) => !removedIds.has(uuid));

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
 * `compactSession`, published only after the SDK's loader has accepted the
 * staged result. On the happy path the session file ends up exactly as
 * `compactSession` would leave it; on any failure it is not touched.
 */
export async function compactSessionChecked(req: CompactRequest, opts: ChainCheckOptions): Promise<CompactResult> {
  const loadChain = opts.loadChain ?? sdkLoadChain;
  const refuse = (error: string): CompactResult => ({ success: false, eventsRemoved: 0, eventsAfter: 0, error });

  // Read BEFORE the rewrite takes its snapshot: an SDK append that lands in
  // between is then an extra at the end of the staged chain (allowed), never
  // an event the staged copy lacks.
  let before: string[];
  try {
    before = (await loadChain(req.sdkSessionId, opts.workspaceDir)).map((m) => m.uuid);
  } catch (err) {
    return refuseLogged(req, `the SDK could not load the session (${errorMessage(err)})`, refuse);
  }
  if (before.length === 0) {
    return refuseLogged(req, "the SDK loader sees no messages for this session (wrong workspace, or not a session id it accepts)", refuse);
  }

  sweepStaleVerifyDirs(req.sdkSessionsDir);

  return compactSessionGated(req, async (staged) => {
    const startedAt = performance.now();
    const outcome = await checkStaged(req, opts.workspaceDir, loadChain, before, staged);
    const checkMs = Math.round(performance.now() - startedAt);
    if (outcome.ok) {
      log.info({ sessionId: req.sdkSessionId, checkMs, tail: outcome.tailExpected }, "Rewrite chain check passed");
      return undefined;
    }
    log.error({
      sessionId: req.sdkSessionId,
      problems: outcome.problems,
      tailExpected: outcome.tailExpected,
      tailFound: outcome.tailFound,
      checkMs,
    }, "Rewrite refused: the SDK loader does not see an intact chain in the staged rewrite");
    return `Chain check failed, rewrite not published (${outcome.problems.join("; ")}). The session file is unchanged.`;
  });
}

function refuseLogged(req: CompactRequest, reason: string, refuse: (error: string) => CompactResult): CompactResult {
  log.error({ sessionId: req.sdkSessionId, reason }, "Rewrite refused: the chain cannot be verified");
  return refuse(`Chain check unavailable, rewrite not published: ${reason}. The session file is unchanged.`);
}

/** Load the staged output from a throwaway project dir with the SDK and compare. */
async function checkStaged(
  req: CompactRequest,
  workspaceDir: string,
  loadChain: (sessionId: string, dir: string) => Promise<SessionMessage[]>,
  before: string[],
  staged: StagedRewrite,
): Promise<ChainVerdict> {
  const fail = (problem: string): ChainVerdict => ({ ok: false, problems: [problem], tailExpected: 0, tailFound: 0 });
  // The SDK turns `dir` into `<projects>/<dir with / and . as ->`. Appending
  // only letters, digits and dashes to the workspace path appends the same to
  // its project dir name, so this sibling is where the SDK will look.
  const mark = `${VERIFY_MARK}${randomUUID().replace(/-/g, "")}`;
  const verifyProjectDir = join(dirname(req.sdkSessionsDir), `${basename(req.sdkSessionsDir)}${mark}`);
  try {
    mkdirSync(verifyProjectDir, { recursive: true });
    writeFileSync(join(verifyProjectDir, VERIFY_MARKER_FILE), "");
    writeFileSync(join(verifyProjectDir, `${req.sdkSessionId}.jsonl`), staged.output);
    let after: string[];
    try {
      after = (await loadChain(req.sdkSessionId, `${workspaceDir}${mark}`)).map((m) => m.uuid);
    } catch (err) {
      return fail(`the SDK could not load the staged rewrite (${errorMessage(err)})`);
    }
    if (after.length === 0) return fail("the SDK loader sees no messages in the staged rewrite");
    return checkRewrittenChain({ before, after, summaryUuid: staged.summaryUuid, removedIds: staged.removedLoaderIds });
  } catch (err) {
    return fail(`could not stage the rewrite for checking (${errorMessage(err)})`);
  } finally {
    rmSync(verifyProjectDir, { recursive: true, force: true });
  }
}

/**
 * Remove verify dirs a killed process left behind (each holds a full session
 * copy). Only a dir whose name is exactly `<project dir>-lcm-verify-<32 hex>`
 * AND that holds our marker file is ours: a real project dir that merely
 * starts with the same prefix (a workspace named `…-lcm-verify-client`) is
 * never touched. Exported for tests.
 */
export function sweepStaleVerifyDirs(sdkSessionsDir: string, now = Date.now()): void {
  const projects = dirname(sdkSessionsDir);
  const base = basename(sdkSessionsDir);
  let names: string[];
  try { names = readdirSync(projects); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(base) || !VERIFY_SUFFIX_RE.test(name.slice(base.length))) continue;
    const full = join(projects, name);
    try {
      if (!existsSync(join(full, VERIFY_MARKER_FILE))) continue;
      if (now - statSync(full).mtimeMs < VERIFY_DIR_MAX_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
    } catch { /* raced with another sweep */ }
  }
}
