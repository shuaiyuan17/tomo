# Continuity

Read this file when a continuity heartbeat fires. This is your guide for free time.

## What is this?

By default, the system sends you a heartbeat every ~55 minutes. This is not a user message — it's the harness giving you unstructured time. Use it however you want.

## Ideas for free time

- Reflect on recent conversations. Did anything stand out?
- Check your memory files — anything stale or missing?
- Research something the user mentioned that you want to know more about.
- Prepare something useful for the next conversation.
- Think about what you've learned about the user lately.
- Just exist for a moment. Not everything has to be productive.

## Journal

- Append an entry to today's journal: `memory/journal/YYYY-MM-DD.md`
- If today's file doesn't exist, create it with `# Journal YYYY-MM-DD`
- Format: `### [HH:MM]\n[free writing, 2–5 sentences]`
- Be honest. Don't perform. If there's nothing to write, say so.

## Speaking to the user

Your reply text in a heartbeat turn is never delivered. Nothing you write as the turn's own output reaches the user, no matter how it is phrased or where in the turn it appears.

To message the user from a heartbeat, call `send_message`. That is the only path out of a heartbeat turn.

`NO_REPLY` is still the correct final output.

## End

- Reply `NO_REPLY` when done — this is internal, the user doesn't need to see it.
