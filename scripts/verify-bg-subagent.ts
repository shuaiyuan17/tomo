/**
 * Verification probe: does the Claude Agent SDK, in long-lived streaming-input
 * mode (the way LiveSession uses it), automatically wake the model with a NEW
 * turn when a background subagent finishes — WITHOUT us sending another user
 * message?
 *
 * This is the load-bearing assumption behind background-subagent support in
 * Tomo. If the SDK never produces that unsolicited turn, the whole feature is
 * a non-starter and no amount of LiveSession plumbing will help.
 *
 * HOW TO RUN (on a machine with creds — NOT the remote container):
 *   1. npm install            # need node_modules
 *   2. export ANTHROPIC_API_KEY=sk-...        # or your LiteLLM gateway:
 *      #   export ANTHROPIC_BASE_URL=http://localhost:4000
 *      #   export ANTHROPIC_API_KEY=<gateway key>
 *   3. npx tsx scripts/verify-bg-subagent.ts
 *
 * WHAT TO LOOK FOR: the script prints a numbered log of every SDK event. The
 * verdict at the end tells you whether a second (unsolicited) turn arrived
 * after the first `result`. That second turn is what LiveSession would need to
 * intercept and route to the channel.
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// ---- streaming input generator (mirrors LiveSession.messageGenerator) ----
let pushUserMessage: ((m: SDKUserMessage) => void) | null = null;
let inputClosed = false;

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  while (!inputClosed) {
    const msg = await new Promise<SDKUserMessage | null>((resolve) => {
      pushUserMessage = (m) => resolve(m);
      // If we close input while waiting, resolve null to end the generator.
      if (inputClosed) resolve(null);
    });
    pushUserMessage = null;
    if (msg === null) return;
    yield msg;
  }
}

function sendUserText(text: string) {
  const msg: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] as never },
    parent_tool_use_id: null,
  } as SDKUserMessage;
  if (!pushUserMessage) throw new Error("generator not waiting for input");
  pushUserMessage(msg);
}

// ---- the probe ----
async function main() {
  const q = query({
    prompt: messageGenerator(),
    options: {
      // Mirror Tomo: bypass permissions so the background subagent can run its
      // tools without prompting (background turns auto-deny anything that would
      // prompt — bypass avoids that trap entirely).
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Agent", "Read", "Glob", "Grep"],
      includePartialMessages: true,
      maxTurns: 30,
    },
  });

  // TRUE fire-and-forget: launch a ~15s background subagent and END THE TURN
  // immediately. We deliberately do NOT ask the model to report the output —
  // that phrasing (in the first version of this probe) made the model keep its
  // turn open and wait, which masked the real question. Now the discriminator
  // is TIMING of the first `result`:
  //   - first result fast (~2s)  => turn closed at LAUNCHED; SDK did NOT force
  //     a wait. Then we watch whether bg completion produces a SEPARATE later
  //     turn (the true unsolicited-turn path) or nothing (silent drop).
  //   - first result slow (~15s) => SDK held the turn open until the bg task
  //     drained regardless of the model's intent => backgrounding is
  //     effectively blocking in long-lived query() mode.
  const startedAt = Date.now();
  sendUserText(
    "Use the Agent tool with run_in_background: true to launch a subagent " +
      "whose task is: run `sleep 15 && echo DONE_FROM_BG` in Bash. " +
      "The MOMENT you have launched it, reply to me with exactly: LAUNCHED — " +
      "then STOP and end your turn. Do NOT wait for the subagent. Do NOT " +
      "report its output. Do NOT call any more tools. Just say LAUNCHED and " +
      "finish.",
  );

  let eventNum = 0;
  let firstResultSeen = false;
  let firstResultAt = 0;
  let firstResultLatencyMs = 0;
  let sawUnsolicitedTurn = false;
  let sawDoneMarker = false;
  let postResultAssistantTurns = 0;

  // Safety: stop iterating ~40s after the first result so the script always
  // terminates even if no second turn ever arrives.
  let watchdog: NodeJS.Timeout | null = null;
  const stop = () => {
    inputClosed = true;
    q.close?.();
  };

  for await (const event of q) {
    eventNum++;
    const e = event as Record<string, unknown>;
    const type = e.type as string;
    const subtype = e.subtype as string | undefined;
    const parentId = (e as { parent_tool_use_id?: string }).parent_tool_use_id;

    // Pull any visible text out of assistant events.
    let textPreview = "";
    if (type === "assistant") {
      const content = (e as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; name?: string };
        if (blk.type === "text" && blk.text) textPreview += blk.text;
        if (blk.type === "tool_use") textPreview += `[tool_use:${blk.name}]`;
      }
    }
    if (textPreview.includes("DONE_FROM_BG")) sawDoneMarker = true;

    // Any top-level (non-subagent) assistant turn AFTER the first result, with
    // no user message sent in between, is the unsolicited-turn signal claw's
    // design hinges on.
    if (firstResultSeen && type === "assistant" && !parentId) {
      postResultAssistantTurns++;
      sawUnsolicitedTurn = true;
    }

    const sinceFirstResult = firstResultAt ? `+${((Date.now() - firstResultAt) / 1000).toFixed(1)}s` : "";
    console.log(
      `#${eventNum} [${type}${subtype ? ":" + subtype : ""}]` +
        (parentId ? ` parent=${parentId}` : "") +
        (textPreview ? ` text="${textPreview.slice(0, 120).replace(/\n/g, " ")}"` : "") +
        (sinceFirstResult ? ` (${sinceFirstResult} after 1st result)` : ""),
    );

    if (type === "result") {
      if (!firstResultSeen) {
        firstResultSeen = true;
        firstResultAt = Date.now();
        firstResultLatencyMs = firstResultAt - startedAt;
        const secs = (firstResultLatencyMs / 1000).toFixed(1);
        console.log(
          `\n>>> First \`result\` arrived after ${secs}s. ` +
            (firstResultLatencyMs > 10_000
              ? "(SLOW — SDK appears to have held the turn open until the bg task drained.)"
              : "(FAST — turn closed at LAUNCHED; bg task should still be running.)") +
            "\n>>> NOT sending another user message. Watching ~40s for a separate turn...\n",
        );
        // Arm watchdog: give the bg subagent time to finish + (maybe) wake us.
        watchdog = setTimeout(() => {
          console.log("\n>>> Watchdog fired (40s) — closing.\n");
          stop();
        }, 40_000);
      } else {
        // A SECOND result with no user message in between == unsolicited turn.
        sawUnsolicitedTurn = true;
        console.log("\n>>> SECOND `result` arrived with no user message sent. This is the unsolicited turn.\n");
        if (watchdog) clearTimeout(watchdog);
        stop();
      }
    }
  }

  const heldTurn = firstResultLatencyMs > 10_000;
  console.log("\n================ VERDICT ================");
  console.log(`Time to first result                 : ${(firstResultLatencyMs / 1000).toFixed(1)}s ${heldTurn ? "(SDK HELD the turn)" : "(turn closed early)"}`);
  console.log(`Separate turn after first result     : ${sawUnsolicitedTurn ? `YES ✅ (${postResultAssistantTurns} assistant turn(s))` : "NO ❌"}`);
  console.log(`Saw background output (DONE_FROM_BG)  : ${sawDoneMarker ? "YES" : "NO"}`);

  console.log("\n---- interpretation ----");
  if (heldTurn) {
    console.log(
      "SDK held the turn open until the background task finished, even though we\n" +
        "told the model to fire-and-forget. In long-lived query() mode, " +
        "run_in_background\nis effectively BLOCKING: send() won't resolve until the bg task drains.\n" +
        "=> The bg result is NOT dropped (good — no silent-drift), but you get little\n" +
        "   over a foreground subagent. True async delivery would need a different\n" +
        "   mechanism (separate query() per task, or agent-scheduled cron follow-up).\n" +
        "   At minimum, raise LiveSession's 10-min send() timeout for long tasks.",
    );
  } else if (sawUnsolicitedTurn) {
    console.log(
      "Turn closed at LAUNCHED AND a separate later turn arrived when the bg task\n" +
        "finished. This is the real deal: true async is viable. LiveSession needs an\n" +
        "unsolicited-turn path (route to channel via the cron-style delivery queue) +\n" +
        "turn-attribution guard + lifecycle protection. Hand this to claw for the PR.",
    );
  } else {
    console.log(
      "Turn closed at LAUNCHED but NO later turn ever arrived — the bg result was\n" +
        "SILENTLY DROPPED. This is exactly claw's silent-drift, and confirms the SDK\n" +
        "does NOT auto-wake in this mode. run_in_background fire-and-forget is unsafe\n" +
        "as-is; the feature needs an explicit delivery mechanism (poll subagent state,\n" +
        "or have the subagent itself send to the channel via the internal MCP tool).",
    );
  }
  console.log(
    "\n(Sanity check the tool_use lines above: confirm the model used Agent with\n" +
      "run_in_background, not an inline foreground Bash. If it ran inline, retest.)",
  );
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
