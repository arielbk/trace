---
name: trace
description: Bind the current Claude Code session to a Trace task, re-enter a task's context from its docs and prior session references, or open the Trace task board. Use when the user says they are working on a task, starts scoping or defining a piece of work (a feature, a fix, a plan), asks to bind the session to a task, asks to re-enter a task by its slug or exact title, asks to open the Trace board, or when session-start context reports that no Trace task is bound to this session and the user is doing real project work.
---

# Trace

Use this skill when the user says they are working on a task, starts scoping
or defining a piece of work, asks to bind the current session to a task, asks
to re-enter a task's context, asks to open the Trace task board, or when
session-start context reports there is no active task for this session.

## No active task for this session

At session start, Trace injects one line of context about this session's task
state. When that line says a task is being tracked (`✓ Trace tracking: <title>`),
the session is already bound — do nothing; do not re-offer to bind it.

When instead it reports that **no task is bound to this session** — or you
otherwise notice the session is doing real project work with nothing tracking
it — follow through rather than letting the signal pass:

- If the line names the project's most recent task ("the most recent task in
  this project is `<title>`"), and the work in this session is continuing that
  task, **offer to re-enter it** (the **Re-enter X** verb) rather than creating
  a near-duplicate. Prefer re-entry whenever a fitting recent task exists.
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

## Verbs

### We're working on X

Resolve an existing task by slug or title `X`, or create one when absent, then
bind the current Claude Code session to it. New task titles should be
human-readable sentence case ("Break stop and stale expiry"), not kebab-case —
the slug is derived automatically.

Starting to **scope or define** a piece of work counts as working on it: when
the user begins scoping, speccing, or defining a feature (e.g. "let's define
X", "let's scope X", or invoking a scoping/spec skill on X), run this same verb
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
exists, drop the flag (tending an existing description is handled under
**Re-enter X** below).

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

### Re-enter X

Resolve an existing task — the slug is the canonical ref; an exact title
(trimmed, case-insensitive) also resolves — then bind the current session to it
and print its docs and prior session references:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill re-enter "break-stop-and-stale-expiry"
```

Re-entry binds the current Claude Code session to the resolved task, just as
**We're working on X** does — going back to a task is itself working on it, so a
re-entered session no longer stays silently unbound. Binding is inferred from
the live session in the environment; when the command is run outside a session
(a human at a bare terminal reading the docs) there is nothing to bind, so it
just prints the manifest. Either way you do not need a separate bind step after
re-entering.

A miss exits non-zero and lists near candidates (slug — title) on stderr; pick
the right slug from that list rather than guessing variants.

When re-entering:

1. Call the command above and treat its output as a manifest. When it carries a
   `description:` line, that is the task's stored summary — use it to orient and
   to confirm you have the right task; don't re-derive it.
2. If the manifest carries a `state:` field, read that file first and treat it
   as the authoritative snapshot of where the task stands. It is the living
   state file written by the `handoff` skill — one summary line, decisions made,
   current state, next step, and open questions. Open with a recap drawn from it.
3. After reading `state.md`, pull other docs from `docs:` only when `state.md`
   links to them or the current work explicitly needs them. Do not read every
   sibling doc by default.
4. When no `state:` field is present, read the decision docs first, in the
   listed order, then fall back to the transcript tail for the `mostRecent: true`
   session with `trace session tail <session-id>` only if those docs do not cover
   the current state.
5. Never paste raw transcripts into the chat, and never ask the user to
   re-explain context that the manifest, docs, or transcript tail already cover.

If, once you are oriented, the work has visibly drifted from the stored
description — the task is now plainly about something the description no longer
captures — **offer** to update it, with the new text you'd write, and apply it
only if the user agrees. Never silently rewrite it.

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" task update "X" --description "new one-line summary"
```

Most re-entries need no such update — only offer when the drift is obvious, not
on every re-entry.

Codex entry point support is deferred. This Claude skill keeps the protocol
tool-agnostic so a Codex wrapper can follow the same manifest consumption rules
later.

### Open the task board

Tell the user to run the Trace web server in their own terminal:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" serve
```

The command reads the live store from `~/.trace/trace.sqlite`, starts the board,
and prints a line like `trace serve listening on http://127.0.0.1:4317`. If that
port is taken, the CLI picks the next available port. Tell the user the URL from
that output.

Do not start the server in the background, track its process, or kill it from
the skill. The user owns that terminal process and stops it with Ctrl-C.

## CLI Setup

This skill invokes the bundled Trace CLI from the plugin root; no global
`trace` command is required and hook registration is declared by the plugin.
If the plugin is not installed, or you need to run the CLI outside the plugin,
see [SETUP.md](SETUP.md).
