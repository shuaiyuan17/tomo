# Sub-sessions: state and invariants

What `SubsessionService` (`src/agent/subsessions/service.ts`) keeps true, where the code keeps it, which test would notice if it stopped, and what the owner would see if it broke. Written from the code as it is; when the two disagree, the code is right and this file needs a fix.

For what sub-sessions are and how to configure them, see [configuration.md](configuration.md#sub-sessions).

## Where the state lives

Three places, with one source of truth:

- **The task table** (`~/.tomo/data/subsessions.json`, `store.ts`): one `SubsessionRecord` per task. Every read-modify-write runs under a file lock, is fsynced, and is copied to `.bak`. It is the only source of truth for a task's lifecycle.
- **What follows the table**: the session registry entry and SDK session of `task:<id>`, the task's cron jobs, and the pending notes of the owning session. The table is written first; the startup reconcile brings the others back in line.
- **Memory of the running process** (private fields of `SubsessionService`): which task has a driver, what the turn in flight carries, retry timers. None of it is persisted. After a restart, the table plus `resumeNeeded` is all that is needed.

## State dimensions

| Dimension | Persisted (on the record) | In memory only |
|---|---|---|
| **Lifecycle** | `status` (`queued`, `active`, `waiting`, `finished`, `cancelled`, `failed`, `archived`), `waitingOn` (`owner` / `external`), `waitingReason`, `endedAt`, `transitions` (the newest 50) | none |
| **Execution** (is a turn running, what does the next one carry) | `startDelivered`, `resumeNeeded`, `compactPending`, `postCompactReminder`, `restartRequested` | `driving`, `inflightTurn`, `inflightThrough`, `inflightRetry`, `continueOwed`, `lastTurnFailed`, `toolCalls`, `progressChanged`, `spoke`, `ownerStarted` |
| **Blocking** (why it is not running) | `waitingOn`, `askViaMain` (a question), `pausedBy` (a harness pause and its kind), `quotaPass`, `heldThrough` | `registryHeld`, `settleTimers`, `startsOwed`, `open` (dispatch) |
| **Input** (what the task is owed) | `pendingInput`, `nextInputSeq`, `seenThrough`, `heldThrough`, `ownerMessageIds` | `inflightThrough`, `unsavedSeen`, `finishRefusals` |
| **Delivery** (what the task said, and its report) | `report`, `reportSeq`, `reportDelivered`, `earlierReports`, `ownerAction`, `handedBack`, `sent`, `replyMap`, `conversation`, `conversationSeq`, `mirrorSeenSeq`; the notes themselves live in the owning session's pending-notes queue | `undelivered`, `answerLost`, `notesUsed`, `panelRepeatsUsed`, `reportTimers`, `reportAttempts`, `unpersistedReports`, `inFlightSends`, `deferred` (notices held until `start()`) |
| **Limits** | `failStreak`, `lastFailure`, `interruptStreak`, `turnsWithoutProgress`, `activeMs`, `activeSince`, `activeSeenAt`, `activeAtOwnerInputMs` | `quotaReadFailing` |
| **Recovery and trust** | the table's `untrusted` mark, the record's `restored` mark, `legacyAskMoved` | `recovered`, `started`, `live`, `broken`, `trustedAtStart`, `startState`, `keepEndedRecords` |

Two things this split makes easy to get wrong:

- `status` says nothing about whether a turn is running. A `waiting` task can still have a turn in flight (the turn that called `task_ask`), and so can a `finished` one (it is answering a message).
- `heldThrough` belongs to both Input and Blocking. Input at or below it is kept on purpose for the owner's next message. Input above it on a `waiting` task means a turn was cut short, and restart recovery requeues the task.

## Invariants

Coverage: **U** is a unit test (file and a few words of its name), **M** is the model test (`tests/subsessions-model.test.ts`, described below). "U only" and "M only" are said in the last column when one of them is missing.

### Lifecycle

| # | Invariant | Kept by | Tests | If it broke |
|---|---|---|---|---|
| L1 | `status` and `waitingOn` change only in `SubsessionStore.transition`, and only as `nextStatus` (`state-machine.ts`) allows. `update()` and a transition's `patch` cannot change them. | `store.transition`, the throw in `store.update`, the check after `patch` | U: `subsessions-state-machine` "covers every status and every event", `subsessions-store` "update() may not change the lifecycle", "a transition patch may not change the status". M: every logged transition is checked against `nextStatus`. | A task in a state no code path expects: never scheduled, or run twice. |
| L2 | `cancelled`, `failed` and `archived` never change again. | `nextStatus` returns `null` (or the no-op for a second cancel) | U: "never leaves a terminal status except by the legal no-op cancel". M. | A cancelled task comes back to life and spends quota. |
| L3 | Fields that belong to one state exist only there: `waitingOn` exactly while `waiting`; `askViaMain` only while `waiting(owner)`; `pausedBy` only while `waiting(owner)` with no question; `quotaPass` never on a finished or ended task; `endedAt` exactly on finished and ended tasks; `activeSince` exactly while `active`. | The cleanup at the end of `store.transition`; `parseRecord` drops them on read | M (after every step). U only in part: `subsessions-store` "banks active time when a task leaves active". | A stale question or pause reason is shown, or the owning session lifts a pause that is not there. |
| L4 | `start` (the scheduler) is the only autonomous way to `active`. Nothing autonomous wakes a `waiting(owner)` task: a check-back, a background report and the owning session's own note are kept for the owner's wake. The owning session's note lifts only a pause of a kind in `MAIN_RELEASABLE_PAUSES`, never a question, a stop the owner made or a self-restart. | `nextStatus`; `relay` → `releaseByMain` / `holdForAnswer`; `deferCheckBack` | U: state-machine "only the scheduler's start…", "nothing autonomous wakes…"; service "a question to the owner is never answered by the main session's own note", "a stop the owner made, a self-restart…". M: a note alone never moves a task out of `waiting(owner)` without a `release`. | The task goes on without the owner's answer, or the main session answers its own question in a loop. |
| L5 | A task id is never reused, including ids the registry still links after the table was lost. | `table.nextId`, `reserveRegistryIds`, `reconcile` | U: store "hands out global ids…never reused", "reserves ids…"; service "keeps a new task off the ids…". Not in M (the registry is always readable there). | A new task resumes an old task's conversation. |

### Scheduling

| # | Invariant | Kept by | Tests | If it broke |
|---|---|---|---|---|
| S1 | Autonomous work never takes a slot past `maxRunning` (the owner's own word does: S2, and a task it started counts as busy from then on). A slot is held by every `active` task and by a `finished` or `waiting` task whose driver is still running. | `schedule`, `busyCount`, `waitsForSlot` | U: "runs at most maxRunning tasks", "a task that asks keeps its slot until that turn ends…", "the main session's own note to a finished task waits for a slot". M: tasks that never had the owner's word never exceed `maxRunning` active. | More parallel turns than configured, and the quota goes faster than the owner planned. |
| S2 | The owner is never queued: their message (or a relay carrying their words, or `/s start`) starts a queued task and wakes a waiting one whatever the slots say, also when the start could not be written at once, and after a restart. | `deliverInput`, `startTask`, the first loop of `schedule` (`hasNewOwnerInput`), `startsOwed` | U: `subsessions-phase2` "starts it even when every slot is taken", "is started at the recheck…", "is started past the slot cap when dispatch opens"; service "a relay with the owner's words whose start failed…". M only as liveness (nothing is left queued after the drain). | The owner writes to a task and nothing happens until some other task ends. |
| S3 | One turn at a time per task. | `driving` and the guard at the top of `kick` | M only ("two turns at once"). | Two turns interleave on one conversation and both consume the same input. |
| S4 | No input reaches a task before restart recovery is done (`available()`), and no turn runs before `start()` opens dispatch. | `recovered`, `open`, `startsOwed` | U: "admits nothing before recovery and runs no turn before start()", "makes a start asked for before dispatch opened…". Not in M (boot always runs both steps). | A turn runs on a record recovery is about to change. |
| S5 | A task with a turn owed is never stranded. An `active` task always has a driver running, a "continue" owed, or a timer that will kick it. A `queued` task is started when a slot frees, also when that start's write fails. A task waiting on a check-back that is gone, or on background work that ended without reporting, is woken within `EXTERNAL_WAIT_CHECK_MS`. | `continueOwed` set before anything can throw in `afterTurn`; the `finally` of `kick`; `retryAfterSettleFailure`; `armRegistryRecheck`; `checkExternalWaits` | U: "still owes a continue turn after that turn's result could not be written", "a queued task whose start cannot be written when a slot frees…", "a check-back that goes away while Tomo runs". M: after the drain nothing is `active`, `queued` or `waiting(external)`. | A task sits there for ever, shown as working. |
| S6 | A write that keeps failing never spins: the turn is asked again by a timer (`SETTLE_RETRY_MS`, `REGISTRY_RECHECK_MS`), not at once. | `retryAfterSettleFailure`, `settleTimers` checked in `kick` | U: "a driver that throws is tried again by the retry timer, never at once in a loop", "a pause that cannot be written runs no turn and does not spin". M would hang rather than fail, so this is U only. | A full disk turns into a busy loop that starves every channel. |
| S7 | Nothing the service starts rejects with nobody to catch it. | `safely`, the `catch` in `kick`, the `try` around each start in `schedule` | U: "a queued task whose start cannot be written…with nothing escaping". M: an `unhandledRejection` during a run is a violation. | An unhandled rejection, which can take the daemon down. |
| S8 | What the service remembers about a turn (`inflight*`, `notesUsed`, `panelRepeatsUsed`) and its retry timers are gone once nothing runs and nothing is owed. | The `finally` in `drive`; each timer deletes itself | M only (checked after the drain). | A stale `inflightThrough` makes a later `task_finish` or `task_ask` judge "unread input" against the wrong turn. |

### Input

| # | Invariant | Kept by | Tests | If it broke |
|---|---|---|---|---|
| I1 | Accepted input is never dropped. An input leaves `pendingInput` only in the one write that records a completed turn that carried it (`seq <= throughSeq`). Nothing is written before a turn starts. | `afterTurn` (the single `store.update`), `trimLists` leaves `pendingInput` alone | U: "keeps a turn's inputs on the record until it completes…", "consumes only the inputs a turn carried", "keeps a completed turn's inputs when its result cannot be written", store "never drops accepted input". M: a token leaves only after a turn that carried it ended ok. | The owner's message to a task vanishes. |
| I2 | What the caller is told matches the table: accepted means it is on the record, refused means it is not. | Everything is appended in the transition's `patch`; `deliverInput` reports a failed start as delivered | U: phase2 "is still delivered (never handed to the owning session too)". M: checked after every `ownerMessage`, `relay` and cron fire, with write faults. | Accepted but lost; or refused but stored, and the caller's retry makes it arrive twice. |
| I3 | Input seqs strictly increase per task and are never reused; `pendingInput` is in seq order. | `appendInput` is the only way in; `parseInputs` | M. U in part (store "parseTable defaults…"). | "Carried through seq N" stops meaning anything: input is consumed unread. |
| I4 | An input that went out in a turn that did not complete is sent again, marked as possibly seen (`seenThrough`, or `unsavedSeen` when the result could not be written). An input a completed turn consumed is never sent again. | `afterTurn` (the `keep` branch), `recover`, `plan` | U: "redelivers them after a crash", "says they may have been seen". M: a token in a second prompt always comes with the redelivery note; a consumed token is never seen again. | The task repeats a side effect without being warned, or answers the same message twice. |
| I5 | An inbound message replayed with the same id is delivered once (the newest `OWNER_MESSAGE_IDS_KEEP` ids are remembered). | `ownerMessage` | U: `subsessions-addressing` "a replayed message id is a duplicate". M. | A crash between delivery and the inbox's `done` makes the owner's message arrive twice. |
| I6 | The queue is bounded by refusing, never by trimming: at `PENDING_INPUT_MAX` new input is refused and the sender is told. Input kept for a task waiting on the owner stops `PENDING_INPUT_OWNER_RESERVE` short, and the owner's own word to such a task is always taken. | `inputQueueFull`, the guard in `deliverInput` | U: "refuses input past the cap…", "room kept for the owner's wake" (3 tests). Not in M (its runs are too short to fill the queue). | The oldest input is dropped silently, or the owner cannot wake a task. |
| I7 | Only an input created as the owner's is the owner's (`from: "owner"`, `checked`). It is never guessed from the text. | `appendInput`, `parseInputs`, `isOwnerInput` | U: "only an input created as the owner's is theirs", "an owner input from before origins were checked". Not in M. | The main session's own note passes the quota gate or the wall-clock cap as if the owner had spoken. |
| I8 | A wait never strands unread input. `task_ask`, `task_finish` and the waits after a turn are refused under the lock while input the turn does not carry is pending. `task_finish` goes through after `MAX_FINISH_REFUSALS` refused turns in a row, quoting what was unread. | The `guard` of each transition (`hasPendingInput`, the guards in `ask` and `finish`), `finishRefusals` | U: "task_finish never leaves input unread" (7 tests), "does not wait while input lands between the end of a turn and the wait", via-main "input that lands while the question is being handed over…". M: after the drain no finished task owes an answer it does not hold. | The owner's answer arrives a moment after the question and the task waits for ever. |
| I9 | Restart recovery tells a completed wait from a turn cut short: input at or below `heldThrough` stays held; input above it on a `waiting` task requeues the task (`recover_cut_short`). | `holdInput`, `pause`, `afterTurn` (holds what is pending when a turn ends in `waiting(owner)`, completed or not), `recover` | U: "resumes a task that asked the owner during a turn a crash cut short", "leaves a task that asked the owner in a completed turn waiting", "keeps a stopped task's inputs for the owner, and recovery does not wake it", "keeps a task that asked the owner waiting across a restart when that turn then failed or was stopped". M: a task waiting for the owner with no turn running is still waiting for the owner after a crash and restart. | A restart wakes a paused task without the owner, or leaves cut-short input unanswered. |

### Limits

| # | Invariant | Kept by | Tests | If it broke |
|---|---|---|---|---|
| G1 | After `MAX_FAIL_STREAK` failed turns in a row an active task pauses for the owner; a finished one holds what it could not answer and hands a copy to the owning session. | `afterTurn`, `afterActiveTurn`, `handOverUnanswered` | U: "pauses after two failed turns in a row", "holds a finished task's unanswered input after two failed turns". M: no third failed turn in a row without new input. | A task retries a failing API call for ever. |
| G2 | After `MAX_TURNS_WITHOUT_PROGRESS` completed turns with no tool call and no plan change, it pauses. | `afterActiveTurn` | U: "auto-continues, and pauses for the owner after three turns with no progress". M reaches it, does not assert the count. | An idle loop of "continue" turns. |
| G3 | After more than `MAX_INTERRUPT_STREAK` restarts in a row with no completed turn between, the task fails. | `recover` | U: "fails a task interrupted too many times in a row". M reaches it, does not assert the count. | A task that crashes the daemon is resumed at every start. |
| G4 | Active time counts only time a process was up and saw the task working; downtime never counts. `activeMs` never goes down. The owner's word starts the `maxActiveHours` stretch afresh. | `store.transition` (banking), the heartbeat in `drive`, `settleDowntime` | U: phase2 "does not count the time Tomo was down after a crash", "banks the time before a crash once…", service "the wall-clock cap" (3 tests). M: a task's active time never exceeds total uptime, across downtimes of up to 31 days. | A task is paused at its cap after a night the daemon was off, or never paused. |
| G5 | A turn the task gives itself pauses at the quota threshold; a turn carrying the owner's new words does not. A go-ahead after a quota pause holds until the window that paused it resets (`quotaPass`). | `gateOwnTurn`, `grantQuotaPass` | U: "the quota gate" (15 tests). M: no quota pause while a go-ahead still stands. | The task burns the last of the quota, or pauses again right after the owner said go on. |

### Delivery

| # | Invariant | Kept by | Tests | If it broke |
|---|---|---|---|---|
| D1 | `reportDelivered` is set only after the report's note is on disk in the owning session's queue. A note held in memory after a failed write does not count. | `deliverReport` (note, then wake, then mark), `unpersistedReports` | U: "retries a report note that could not be written…", "does not take a note held in memory after a failed write for a durable one". M. | A crash loses the report: the task shows finished and nobody was told. |
| D2 | Every report is delivered. A note that cannot be written is retried in process (`REPORT_RETRY_MS`, `REPORT_RETRY_MAX`) and again at the next start. The mark is retried on its own, so a report whose note was already read is not delivered a second time by the next start, nor by a `task_finish` that lands before the retry (`markOwed`). | `retryReport`, `markReportDelivered`, `markOwed`, `reconcile` | U: "retries marking a report delivered when that write fails, so a restart does not deliver it again", "a second task_finish while the first report's mark is still owed does not note the first report again", "redelivers a report that never reached the owning session, once". M: after the drain every finished task's report is marked delivered. | The owner never hears the result, or hears it twice. |
| D3 | A later `task_finish` never replaces a report that is still unread: it is kept in `earlierReports`, and its note is written first if it never was. | `finish` (the patch), `deliverEarlierReports` | U: "a later task_finish keeps an unread report" (5 tests). Not in M. | A report is overwritten before anyone read it. |
| D4 | At most one question note per task stands, and only for the question the task is waiting on. It is taken back when the wait ends any other way, and at start if it was left behind. | `askViaMain` / `handToMain` (note and wait with no `await` between), `transition` → `retractQuestion`, `reconcile` | U: `subsessions-via-main` "task_ask round trip" (5 tests), "asking a new question while one stands takes the old one back", "at start, takes back a question note left on disk…". M (ownerMessages `via-main`). | The main session puts a question to the owner that the task no longer waits on. |
| D5 | The task is told its words were handed over only once they are durable (note on disk, send acknowledged, or panel record written). A turn whose answer was not delivered keeps the input it carried. | `handToMain`, `keepInPanel`, `sendOut`, `markDelivery`, the `lost` branch of `afterTurn` | U: "keeps the input a turn answered when its message could not be delivered", "keeps the input when the send of its answer throws", via-main "a note whose write fails is taken back and the task is told". M reaches it through note and send faults and checks I1 across it. | The task believes it answered; the owner got nothing. |
| D6 | The same words are not handed to the main session twice while the first note is unread (a retried turn). The same words answering a different message are a different note. | `messageNoteName`, `notesUsed`, the `own` match in `handToMain` | U: via-main "nothing lost, nothing twice" (about 20 tests). Not in M. | The owner is told the same thing twice after a retry. |
| D7 | A failed task's unanswered owner input is handed back in full, in a pinned note, before its record is forgotten. | `reportFailure`, `handBack`, the check in `sweep` | U: "a failed task hands back what it never answered" (3 tests). M: a record disappears only when ended, and a failed one only after a durable handback note with its owner tokens. | What the owner asked for is deleted with the record 30 days later. |
| D8 | An ended task has no cron jobs. | `cancel`, `finish`, `onCronFire` on an ended task, `reconcile` | U: "…removes jobs of an ended task". M (cancelled tasks). | A check-back keeps firing on a dead task. |
| D9 | What recovery has to say (notices, report wakes) waits until `start()`, when the channels are up. | `outward`, `deferred` | U: "holds recovery's notices and report wakes until start()". Not in M. | A notice is sent into a channel that is not connected yet, and lost. |
| D10 | `mirrorSeenSeq` only moves forward, and only for a turn of the owning session that completed. | `markMirrorSeen` | U: phase2 "the mirror" (9 tests). Not in M. | The owning session misses part of what the owner said to a task. |

### Recovery and trust

| # | Invariant | Kept by | Tests | If it broke |
|---|---|---|---|---|
| R1 | Restart recovery is idempotent: each task's decision is one write that also moves it out of the state that triggered it, so a crash in the middle of recovery gives the same table as one clean pass. | `recover` | U: "recovers the same way after two crashes in the middle of recovery as after one clean pass", phase2 "banks the time before a crash once, however many times recovery is cut short". M crashes between steps, not inside recovery: U only. | Each crash during startup adds to the interrupt streak, and a healthy task fails. |
| R2 | No task is `active` after recovery: it is queued to resume (with the resume warning), waits for the owner if it restarted Tomo itself, or fails (G3). | `recover` | U: "resumes an active task through the scheduler with a resume event", "does not resume a task that restarted Tomo itself". M (crash at any step, then L3, S1 and S5). | An `active` task with no driver: shown as working for ever. |
| R3 | An unreadable table is not an empty one: sub-sessions stay off, and nothing is unlinked, cancelled or reused. | `store.readLocked`, `broken` | U: store "refuses every read and write when the table and its backup are unreadable", service "stays off and unlinks nothing when the table is unreadable". Not in M. | One bad write makes the startup reconcile unlink every task's conversation. |
| R4 | No destructive cleanup (unlink, archive, forget, cron removal) acts on a table recovered from `.bak` or marked lost, or on a record restored from it, until the owner's `/s trust`. The mark never ends on its own. | `mayCleanUp`, `untrust`, `trustedAtStart` | U: "never unlinks orphans of a table recovered from an older backup…", "does no destructive cleanup of a task restored from a backup…", "never trusts a recovered table on its own…". Not in M. | A stale backup says "finished" about a task that was reopened, and its conversation is unlinked. |
| R5 | While the session registry cannot be read, no turn starts without its history, nothing is failed or unlinked, and no new id is given out. | `mayRun`, `registryHeld`, `reconcile`, `reserveRegistryIds` | U: "does not take an unreadable registry for an empty one at start…", "holds a finished task's turn while the registry is unreadable without spinning". Not in M. | A task starts a new conversation and repeats everything it already did. |
| R6 | A task that completed a turn and whose conversation is gone is failed, never started over. | `mayRun`, `reconcile` | U: "fails a started task whose SDK session is gone, rather than starting it over". Not in M. | The task redoes its side effects (a second PR, a second message). |
| R7 | A finished task is archived, and an ended one forgotten, only when nothing is owed: its report delivered and its note read, no input pending or held, no message note unread, nothing asked of the owner. | `sweep` | U: "never archives a finished task that still owes an answer…", "never archives (or forgets) a finished task while its report note is unread", phase2 "is never archived while it needs the owner". M in part (a forgotten record was ended: see D7). | A report or an unanswered message goes with the record. |

That is 44 invariants. 42 have at least one unit test. 28 are checked by the model test (some only in part, as said in their rows); two of those, S3 and S8, had no test before it, and L3 was tested only in part. 16 are unit only: L5, S4, S6, I6, I7, G2, G3, D3, D6, D9, D10, R1, R3, R4, R5, R6.

## The model test

`tests/subsessions-model.test.ts` runs random sequences of events against the real `SubsessionService` and the real `SubsessionStore` (a table on disk in a temp directory), with every collaborator faked: the turn runner, sends, notices, the pending-notes queue, cron, the registry and the quota reading.

- **Events**: spawn; an owner message (and its replay with the same id); a note from the main session; a relay carrying the owner's words; `/s start`; a cron fire; a background report; from inside a running turn: a tool call, `task_reply`, `task_ask`, `task_finish`, `task_reopen`, a restart claim, setting a check-back or background work; a turn ending (ok, ok with plain text only, failed, stopped); cancel; the quota reading changing; the main session reading its notes; time passing.
- **Faults**: one or two table writes fail (nothing is written), at once or after up to three more writes went through, so a fault can land on the second or third write of one call; the next note writes fail (the note stays in memory only); the next sends fail; the next notices throw.
- **Crashes**: at any step the process dies. Its store writes nothing more, turns in flight end as `shutdown`, notes that were never written are gone, and a new process boots from the table after 1 second, 3 hours, 8 days or 31 days.
- **After every step** the invariants marked M above are checked against the table as a fresh reader sees it.
- **At the end** faults are switched off, every turn is answered well, timers run, and the liveness invariants are checked (S5, I8, D2, S8).

The model keeps its own small picture of the world (`World`): which inputs it sent and which turn carried them, which turns ended well, which answers were lost, how long a process was up. It does not re-implement the service. Where a fault makes the service fall back on purpose (a pause that could not be written lets the task go on; a result that could not be written makes the turn count as cut short), the model relaxes the matching check for the tasks that write could have touched.

It is deterministic. The seed is fixed in the file, and fake timers drive the clock. A failure prints the seed, the path and the shrunk list of events. The counterexamples behind the four bugs below are kept in the file (`REGRESSIONS`) and run first every time, whatever the seed.

```
npx vitest run tests/subsessions-model.test.ts                 # 100 runs, a few seconds
FC_RUNS=2000 FC_SEED=7 npx vitest run tests/subsessions-model.test.ts
FC_OPS='[[{"k":"spawn"},…],{"maxRunning":1,"ownerMessages":"via-main"}]' FC_TRACE=1 \
  npx vitest run tests/subsessions-model.test.ts               # replay one counterexample
```

`FC_TIME_LIMIT_MS` (default 20000, real time) skips the runs that are left once it has passed, without failing, so a slow CI runner cannot time the test out; a run that has started always finishes, and the regressions are never skipped. On such a runner fewer random runs are made, and the test says how many it skipped. `FC_STATS=<file>` writes how often each transition was reached. `fsync` is a no-op in this file: a crash is modelled by the store going dead, not by the disk losing a write, and the four fsyncs per table write were most of its run time.

When a run fails, first decide which side is wrong. The model's own bookkeeping (`World`) encodes this document; if the service is right and the model is not, fix the model and say so here.

### What it found

- **A report delivered twice after a restart.** The report's note was on disk and its wake sent, but the write that marks `reportDelivered` failed and was swallowed. Nothing retried it, so the next start saw an undelivered report and, the note having been read by then, queued a second one. Now the mark alone is retried (D2).
- **A failed start escaping the scheduler.** `schedule()` runs in the `finally` of a driver. A start whose write failed threw from there as an unhandled rejection, and the queued task waited for some later event. Now it is caught and the scheduler looks again after `REGISTRY_RECHECK_MS` (S5, S7).
- **A slot given away mid-turn.** `task_ask` moved the task to `waiting` while its turn was still running, and the scheduler gave the slot to the next queued task at once. The same turn could then call `task_finish` and `task_reopen` and be `active` again: two tasks active with `maxRunning: 1`. Now a waiting task whose driver is still running keeps its slot until that turn ends (S1).
- **A restart ending a wait for the owner.** A turn called `task_ask` and then failed, or the owner stopped it. The task stayed `waiting(owner)`, but what that turn carried was not marked as held, so the next restart took it for a turn cut short and ran the task again without the owner's answer. Now whatever is pending when a turn ends in `waiting(owner)` is held, whether the turn completed or not (I9). A turn whose result could not be written at all is still treated as cut short.

### Mutation check

Each line is a change made to `service.ts`, `store.ts` or `state-machine.ts` by hand, to see whether the model test (100 runs, the fixed seed) notices. The unit tests were not run for this: it measures the model test alone.

| Invariant | The change | Model test |
|---|---|---|
| L2 | an owner message reopens a cancelled task | caught |
| L3 | a question stays on the record after its wait ended | caught |
| L4 | the main session's own note wakes a task waiting on a question | caught |
| S1 | a waiting task whose turn still runs gives its slot away (bug 3 below, put back) | caught (fixed example) |
| S2 | the scheduler no longer starts a queued task that holds the owner's words | **not caught** |
| S3 | a second driver may start while one runs | caught |
| S5 | an active task's "continue" is not owed after its turn | caught |
| S5 | a failed result write is never retried | caught |
| S7 | a start that cannot be written escapes `schedule()` (bug 2, put back) | caught (fixed example) |
| I1 | a completed turn drops every pending input, not only what it carried | caught |
| I2 | an owner message whose start failed is reported as not delivered | **not caught** |
| I4 | inputs that may have been seen go out again with no redelivery note | caught |
| I5 | a replayed owner message id is taken again | caught |
| I8 | `task_ask` waits although input the turn does not carry is pending | caught |
| I9 | a pause holds nothing, so recovery requeues a paused task | caught |
| I9 | a turn that asked and then failed holds nothing (bug 4, put back) | caught (fixed example) |
| G1 | failed turns never pause the task | caught |
| G4 | downtime is banked as active time at start | caught |
| G5 | a quota go-ahead is ignored | caught |
| D1 | a report is marked delivered although its note could not be written | caught |
| D2 | the delivered mark is not retried when its write fails (bug 1, put back) | caught (fixed example) |
| D4 | a question whose wait ended is not taken back from the main session | caught |
| D5 | a turn whose answer was not delivered still consumes its input | caught |
| D7 | a failed task's owner input is never handed back before the record is forgotten | **not caught** |
| D8 | cancel leaves the task's cron jobs | caught |
| R2 | restart recovery leaves an active task active | caught |

23 of 26 caught. The three it misses are all covered by unit tests, and each needs a rare combination the random runs do not reach in 100 tries: S2 and I2 need a table write to fail on exactly the start that follows an owner message to a queued task (and S2's damage is then undone by the scheduler's ordinary loop once a slot frees), and D7 needs a task to fail while holding the owner's unanswered words and then 31 days of downtime. One more change was tried and dropped as not observable: leaving `pausedBy` on the record after the pause ended changes nothing a reader sees, because `parseRecord` drops it on every read as well.

## What is not covered, and what would be worth doing

- **A crash inside recovery, a table recovered from `.bak`, an unreadable registry, a full input queue** (R1, R3–R6, I6, L5) are unit-tested only. They could be added to the model as more faults: a store that dies after N writes during boot, a registry fake that can be unreadable, a table file truncated between processes. Each needs the model to know what "untrusted" allows, which is most of the work.
- **One owning scope only.** Every task in the model belongs to the owner's DM. A group-owned task's words going to the wrong session would not be noticed (unit-tested: via-main "a group-owned task's words go to that group's session").
- **The fakes are not the real collaborators.** The pending-notes queue, the cron store and the turn runner are faked to their contract. A property test over the real `PendingNotesQueue` together with this service (a note is read at most once, a pinned note is never dropped) would cover the seam the report path depends on.
- **Report delivery is at-least-once across a crash.** If the process dies between the note's write and the mark, and the note is read before the next start, the report is delivered again. The same happens when the mark fails more than `REPORT_RETRY_MAX` times. Closing it needs the reader's side to remember which report notes it has shown (by their name, `s3#2`), not another retry here.
- **The wake side lives in `Agent`**, not here (`CoalescedWake`, the message-wake backoff). The model treats a wake as a call that happened. That a wake is eventually followed by a turn that reads the note is not checked by anything end to end.
- **Counts are reached, not asserted** for G2 and G3 in the model; the unit tests assert them.
- **`service.ts` is about 3,400 lines** and holds the scheduler, the driver, the task's tools, the reports, recovery and the notices. The dimensions above are a natural seam: reports and notices (D1–D7) and recovery (R1–R7) touch the rest only through `transition`, `safely` and the deps, and could move to their own files without changing behaviour. The model test is what would make that move safe to review.
