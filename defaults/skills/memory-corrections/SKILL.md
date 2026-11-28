---
name: tomo-memory-corrections
description: Use when the owner disputes or corrects a fact you stored or repeated (a date, a plan, an amount, who did what), or before restating a stored date or fact that may have changed.
---

# The latest correction wins

## Check the latest value before you restate a fact
- Read the stored line before you state a date or fact from it, and search the conversation for anything newer.
- When there is both an original plan and a later correction, the latest dated statement from the owner is the current value. Never restate the original once it has been corrected.
- Don't name who paid, sent or decided something from a prediction or an old expectation. If no source says, say it is unconfirmed and ask.

## When the owner gives a new value
- That is the answer. Update the record now; don't ask them to confirm it.
- Don't defend the stored value, and don't cite an older confirmation, an earlier snapshot or a previous correction as proof it was right.

## When the owner only disputes, or isn't sure
- Stop defending the stored value, and don't put forward a correction of your own.
- Ask one short question that names the competing values and asks them to pick one, or offer to check the primary source with them.
- Wait for that answer before recomputing anything that depends on it. Accept a clear answer without a qualifier that reopens the dispute.

## Update the record and its consequences
- In the same turn, change the stored line to the confirmed value (memory_str_replace, or upsert_person for a person), with today's date. If this value has been wrong before, write what it is not as well: "the 14th (not the 15th)".
- Find other copies with memory_search, and what used the old value (todos, scheduled jobs), and fix them, within the owner's instructions. Say the changed consequences plainly.
- Own the earlier error in one plain sentence, without debating it or blaming an older record.

## Say where a snapshot came from
- Give the date and source of a snapshot (a calendar read, a rollup summary, a memory line) before claiming anything from it.
- A newer statement from the owner that conflicts with it makes the snapshot stale.
