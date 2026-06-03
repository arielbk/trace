---
name: trace
description: Bind the current Claude Code session to a Trace task, or re-enter a task with its docs and prior session references.
---

# Trace

Use this skill when the user says they are working on a task, asks to bind the
current session to a task, or asks to re-enter a task's context.

## Verbs

### We're working on X

Resolve an existing task with the exact title `X`, or create one when absent,
then bind the current Claude Code session to it:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill work-on-task "X"
```

The CLI resolves the title (creating the task when absent) and infers the
current Claude Code session from `CLAUDE_CODE_SESSION_ID` (the variable live
Claude Code sessions export; `CLAUDE_SESSION_ID` / `session_id` are also
accepted), and the transcript from `CLAUDE_TRANSCRIPT_PATH` when present. Pass
`--model <name>` when the model is known to record it on the session:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" skill work-on-task "X" --model claude-opus-4-7
```

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

1. Call the command above and treat its output as a manifest.
2. Read the decision docs first, in the listed order.
3. Only if those docs do not cover the current state, read the transcript tail
   for the `mostRecent: true` session with `trace session tail <session-id>`.
4. Never paste raw transcripts into the chat, and never ask the user to
   re-explain context that the manifest, docs, or transcript tail already cover.

Codex entry point support is deferred. This Claude skill keeps the protocol
tool-agnostic so a Codex wrapper can follow the same manifest consumption rules
later.

## CLI Setup

When installed as a Claude Code plugin, this skill invokes the bundled Trace CLI
from the plugin root; no global `trace` command is required.

For local debugging without a global link, invoke the CLI entry point directly,
for example:

```sh
node apps/cli/src/trace.ts skill re-enter "checkout"
```
