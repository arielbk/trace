---
name: trace
description: Bind the current Claude Code session to a Trace task, re-enter a task's context from its docs and prior session references, or open the Trace task board. Use when the user says they are working on a task, asks to bind the session to a task, asks to re-enter a task by its exact title, or asks to open the Trace board.
---

# Trace

Use this skill when the user says they are working on a task, asks to bind the
current session to a task, asks to re-enter a task's context, or asks to open
the Trace task board.

## Verbs

### We're working on X

Resolve an existing task with the exact title `X`, or create one when absent,
then bind the current Claude Code session to it.

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

The command prints `taskDocsDir: <path>`. Put task-specific decision docs,
plans, handoffs, and notes in that directory so future re-entry sees them
without a separate registration step.

### Re-enter X

Resolve an existing task with the exact title `X`, then print its docs and prior
session references:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill re-enter "X"
```

When re-entering:

1. Call the command above and treat its output as a manifest. When it carries a
   `description:` line, that is the task's stored summary — use it to orient and
   to confirm you have the right task; don't re-derive it.
2. Read the decision docs first, in the listed order.
3. Only if those docs do not cover the current state, read the transcript tail
   for the `mostRecent: true` session with `trace session tail <session-id>`.
4. Never paste raw transcripts into the chat, and never ask the user to
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
