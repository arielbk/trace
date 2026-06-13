# Trace in Claude Code

This is the Claude Code binding flow for the `trace` skill. The shared verbs
(`work-on-task`, re-entry) live in `../SKILL.md`; this file covers what is
specific to Claude Code.

## No active task for this session

At session start, Trace injects one line of context about this session's task
state. When that line says a task is being tracked (`✓ Trace tracking: <title>`),
the session is already bound — do nothing; do not re-offer to bind it.

When instead it reports that **no task is bound to this session** — or you
otherwise notice the session is doing real project work with nothing tracking
it — follow through rather than letting the signal pass:

- If the line names the project's most recent task ("the most recent task in
  this project is `<title>`"), and the work in this session is continuing that
  task, **offer to re-enter it** — handing off to the `trace-reenter` skill,
  which owns the re-entry flow — rather than creating a near-duplicate. Prefer
  re-entry whenever a fitting recent task exists.
- If there is no such task, or the work is plainly new, **offer to start
  tracking it** (the **We're working on X** verb in `../SKILL.md`), drafting the
  title and description yourself from the conversation.

Guardrails — the lean-in is toward responding to the no-task signal, not toward
eagerly creating tasks:

- **Offer, don't auto-bind.** Surface the offer and bind only once the user
  agrees (or has clearly already asked to track this work). Never silently
  create or bind a task on the strength of the nudge alone.
- **Prefer re-entry over duplication.** When a recent task plausibly covers the
  work, re-enter it instead of spawning a parallel near-duplicate.
- **Skip throwaway sessions.** Don't offer to bind quick questions, one-off
  exploration, or scratch sessions the user never meant to track. Wait for real
  project work, or the user's nod, before offering.

## Session inference

The CLI infers the current Claude Code session from `CLAUDE_CODE_SESSION_ID`
(the variable live Claude Code sessions export; `CLAUDE_SESSION_ID` /
`session_id` are also accepted), and the transcript from
`CLAUDE_TRANSCRIPT_PATH` when present. Pass `--model <name>` when the model is
known to record it on the session.
