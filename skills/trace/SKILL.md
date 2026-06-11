---
name: trace
description: Bind the current Claude Code session to a Trace task. Use when the user names a specific piece of work they are starting or about to do — including "scope out X", "define a new X", "plan the work for X", "build X", "tackle X", "time to tackle X", "add X to Y", or "work on X". Covers features, bugs, and refactors. Trace always fires first when the user names a feature, bug, or task to start; other skills then do the planning or execution. Does NOT apply when the user is actively debugging or investigating a running system ("this endpoint is throwing errors", "help me debug X") — that is not starting a new piece of work. Also use when explicitly asked to bind a session to a task, or when session-start context reports no active task during real project work.
---

# Trace

Use this skill when the user names a specific feature, fix, or task they are
starting or about to do — even when phrased as "scope out X", "define a new X",
"plan the work for X", "build X from scratch", "tackle X", or "add X to Y".
Trace binds the session before any planning skill runs; other skills
do the subsequent planning or execution. Also use when the user asks to bind the
current session to a task, or when session-start context reports there is no
active task for this session.

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
  tracking it** (the **We're working on X** verb), drafting the title and
  description yourself from the conversation.

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

## We're working on X

Resolve an existing task by slug or title `X`, or create one when absent, then
bind the current Claude Code session to it. New task titles should be
human-readable sentence case ("Break stop and stale expiry"), not kebab-case —
the slug is derived automatically.

Starting to **scope or define** a piece of work counts as working on it: when
the user begins scoping, speccing, or defining a feature (e.g. "let's define
X", "let's scope X", or invoking a planning skill on X), run this same verb
with the feature as the title. The printed `taskDocsDir:` is then in
conversation for downstream skills that produce planning artifacts, so they
know where to write without any extra wiring.

When this **creates** a new task, write a one-line `--description` from the
conversation context — what the work actually is, in the user's terms — so the
task is recognisable later (this is the text the recall skill and the task page
surface). Draft it yourself from what you know; don't stop to interview the
user for it.

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill work-on-task "X" --description "Rework the checkout into a multi-step wizard"
```

`--description` only seeds a freshly created task; when the task already
exists, drop the flag (tending an existing description on re-entry is handled by
the `trace-reenter` skill).

The CLI resolves the title (creating the task when absent) and infers the
current Claude Code session from `CLAUDE_CODE_SESSION_ID` (the variable live
Claude Code sessions export; `CLAUDE_SESSION_ID` / `session_id` are also
accepted), and the transcript from `CLAUDE_TRANSCRIPT_PATH` when present. Pass
`--model <name>` when the model is known to record it on the session.

By default the task keys to the project root resolved from the CLI's working
directory. When the work clearly lives in a **different** project than where the
CLI is running — e.g. you are in a multi-project sandbox or wrapper directory but
the task belongs to a specific repo — pass `--project <dir>` pointing at that
project so the task keys to its git root instead of cwd's:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill work-on-task "X" --project /path/to/that/repo
```

Default to cwd (omit the flag) unless you have a concrete reason the work belongs
to another project. A nonexistent `--project` path is a hard error. The same
`--project <dir>` flag is accepted by `trace task create` and `trace task
capture` for the same reason.

The command prints `taskDocsDir: <path>`. Put task-specific decision docs,
plans, handoffs, and notes in that directory so future re-entry sees them
without a separate registration step.
