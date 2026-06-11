/**
 * Verification probe #2: does config `steering` (PR
 * claude/queued-messages-task-processing) actually let you talk to the agent
 * WHILE a background subagent is still running?
 *
 * The open question from probe #1: run_in_background holds the parent turn
 * open until the subagent finishes. Steering injects a mid-turn message "at
 * the next tool-call boundary". But during the held-open wait the MAIN agent
 * is idle — the only tool activity is the SUBAGENT's. So:
 *   (a) subagent tool boundaries DO let the steered message in mid-turn
 *       => the agent answers our injected question BEFORE the bg task finishes
 *       => true "chat while it runs". ✅
 *   (b) only the main agent's own boundaries count
 *       => our question is queued and answered only AFTER the bg task drains. ❌
 *
 * This probe replicates the PR's eager input-queue (push even while a turn is
 * in flight; the SDK pumps it to the CLI as soon as we yield) and measures
 * WHEN the injected question gets answered relative to bg completion.
 *
 * HOW TO RUN (machine with creds — NOT the remote container):
 *   npm install
 *   export ANTHROPIC_API_KEY=sk-...        # or your LiteLLM gateway vars
 *   npx tsx scripts/verify-steer-during-bg.ts
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Unique markers so we can unambiguously spot each thing in the stream.
const BG_MARKER = "DONE_FROM_BG";
const STEER_Q = "What is 123 + 456? Reply with ONLY the number and nothing else.";
const STEER_ANSWER = "579";

// ---- eager input queue (mirrors the PR's LiveSession.inputQueue) ----
const inputQueue: SDKUserMessage[] = [];
let inputWaiter: (() => void) | null = null;
let alive = true;

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  while (alive) {
    while (inputQueue.length === 0) {
      if (!alive) return;
      await new Promise<void>((r) => { inputWaiter = r; });
      inputWaiter = null;
    }
    yield inputQueue.shift()!;
  }
}

function pushText(text: string) {
  inputQueue.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] as never },
    parent_tool_use_id: null,
  } as SDKUserMessage);
  inputWaiter?.();
}

const now = () => Date.now();

async function main() {
  const q = query({
    prompt: messageGenerator(),
    options: {
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Agent", "Read", "Glob", "Grep"],
      includePartialMessages: true,
      maxTurns: 40,
    },
  });

  const startedAt = now();
  // Message 1: launch a LONG background subagent (so we have a wide window to
  // inject mid-turn), foreground-sleep inside it so timing is clean.
  pushText(
    "Use the Agent tool with run_in_background: true to launch a subagent. " +
      "The subagent's task prompt must be EXACTLY: \"Run this single Bash " +
      "command in the FOREGROUND and wait for it to finish — do NOT background " +
      `it: \`sleep 25 && echo ${BG_MARKER}\`. Then report the exact stdout.\" ` +
      "After launching it, reply to me with exactly: LAUNCHED. Do not wait.",
  );

  let steerInjected = false;
  let steerAt = 0;
  let launchedSeen = false;
  let bgDoneAt = 0;
  let answerAt = 0;
  let firstResultAt = 0;
  let answerBeforeBgDone = false;
  let answerBeforeFirstResult = false;

  let watchdog: NodeJS.Timeout | null = null;
  const stop = () => { alive = false; inputWaiter?.(); q.close?.(); };

  for await (const event of q) {
    const e = event as Record<string, unknown>;
    const type = e.type as string;
    const subtype = e.subtype as string | undefined;
    const parentId = (e as { parent_tool_use_id?: string }).parent_tool_use_id;

    let text = "";
    let toolName = "";
    if (type === "assistant") {
      const content = (e as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; name?: string };
        if (blk.type === "text" && blk.text) text += blk.text;
        if (blk.type === "tool_use") toolName = blk.name ?? "";
      }
    }

    const isTopLevel = type === "assistant" && !parentId;
    const t = ((now() - startedAt) / 1000).toFixed(1);
    const sinceSteer = steerAt ? ` (+${((now() - steerAt) / 1000).toFixed(1)}s after steer)` : "";
    console.log(
      `[${t}s] ${type}${subtype ? ":" + subtype : ""}` +
        (parentId ? ` (subagent)` : isTopLevel ? ` (MAIN)` : "") +
        (toolName ? ` tool=${toolName}` : "") +
        (text ? ` "${text.slice(0, 90).replace(/\n/g, " ")}"` : "") +
        sinceSteer,
    );

    // Mark bg completion: the subagent reporting the marker, or any text marker.
    if (text.includes(BG_MARKER) && !bgDoneAt) {
      bgDoneAt = now();
      console.log(`    >>> bg marker (${BG_MARKER}) seen at ${t}s`);
    }

    // The injected answer: a TOP-LEVEL (main agent) message containing 579.
    if (isTopLevel && text.includes(STEER_ANSWER) && steerInjected && !answerAt) {
      answerAt = now();
      answerBeforeBgDone = bgDoneAt === 0; // bg not done yet when we answered
      answerBeforeFirstResult = firstResultAt === 0;
      console.log(`    >>> STEERED QUESTION ANSWERED at ${t}s (bgDone=${bgDoneAt ? "yes" : "no"}, firstResult=${firstResultAt ? "yes" : "no"})`);
    }

    // Inject the steered question shortly after we see top-level "LAUNCHED",
    // while the bg subagent should still be sleeping.
    if (isTopLevel && text.includes("LAUNCHED") && !launchedSeen) {
      launchedSeen = true;
      setTimeout(() => {
        if (!alive) return;
        steerInjected = true;
        steerAt = now();
        console.log(`\n>>> INJECTING steered question mid-turn at ${((now() - startedAt) / 1000).toFixed(1)}s: "${STEER_Q}"\n`);
        pushText(STEER_Q);
      }, 2000);
      // Safety net: stop ~20s after the bg marker should have appeared.
      watchdog = setTimeout(() => { console.log("\n>>> Watchdog fired — closing.\n"); stop(); }, 60_000);
    }

    if (type === "result") {
      if (!firstResultAt) firstResultAt = now();
      // Stop once we've both answered the steer AND drained the bg task,
      // or after a second result.
      if (answerAt && bgDoneAt) {
        if (watchdog) clearTimeout(watchdog);
        stop();
      }
    }
  }

  console.log("\n================ VERDICT ================");
  const fmt = (t: number) => (t ? `${((t - startedAt) / 1000).toFixed(1)}s` : "never");
  console.log(`Steered question injected at : ${fmt(steerAt)}`);
  console.log(`Steered question answered at : ${fmt(answerAt)}`);
  console.log(`Background task completed at : ${fmt(bgDoneAt)}`);
  console.log(`First result at              : ${fmt(firstResultAt)}`);
  console.log();
  if (answerAt && answerBeforeBgDone) {
    console.log(
      "CASE (a) ✅ — the agent answered the injected question BEFORE the bg task\n" +
        "finished. Steering DELIVERS mid-turn during a run_in_background wait. This\n" +
        "is true 'chat while it runs', using the native bg subagent tool. The PR is\n" +
        "the answer — no detached-session machinery needed.",
    );
  } else if (answerAt && !answerBeforeBgDone) {
    console.log(
      "CASE (b) ❌ — the injected question was answered only AFTER the bg task\n" +
        "finished. Steering did NOT get a boundary during the idle wait; the message\n" +
        "was effectively queued as a follow-up turn. The PR improves message intake\n" +
        "but does NOT give true concurrency with a bg subagent — for that you still\n" +
        "need the detached-session approach.",
    );
  } else {
    console.log(
      "INCONCLUSIVE — never saw the steered answer. Check the log: did the model\n" +
        "actually launch a bg subagent (Agent + run_in_background)? Did it ever emit\n" +
        "a top-level message containing " + STEER_ANSWER + "? Tighten and retry.",
    );
  }
  console.log("\n(Sanity-check the log: confirm msg1 used Agent run_in_background and the\nsubagent ran sleep in the FOREGROUND, not a nested background Bash.)");
}

main().catch((err) => { console.error("probe failed:", err); process.exit(1); });
