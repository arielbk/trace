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
node .claude/skills/trace/trace-skill.mjs work-on-task "X"
```

The helper forwards to `trace skill work-on-task` and lets the CLI infer the
current Claude Code session from `CLAUDE_CODE_SESSION_ID` (the variable live
Claude Code sessions export; `CLAUDE_SESSION_ID` / `session_id` are also
accepted), and the transcript from `CLAUDE_TRANSCRIPT_PATH` when present. Pass
`--model <name>` when the model is known to record it on the session:

```sh
node .claude/skills/trace/trace-skill.mjs work-on-task "X" --model claude-opus-4-7
```

The command prints `taskDocsDir: <path>`. Put task-specific decision docs,
plans, handoffs, and notes in that directory so future re-entry sees them
without a separate registration step.

### Re-enter X

Resolve an existing task with the exact title `X`, then print its docs and prior
session references:

```sh
node .claude/skills/trace/trace-skill.mjs re-enter "X"
```

When re-entering:

1. Call the helper above and treat its output as a manifest.
2. Read the decision docs first, in the listed order.
3. Only if those docs do not cover the current state, read the transcript tail
   for the `mostRecent: true` session with `trace session tail <session-id>`.
4. Never paste raw transcripts into the chat, and never ask the user to
   re-explain context that the manifest, docs, or transcript tail already cover.

Codex entry point support is deferred. This Claude skill keeps the protocol
tool-agnostic so a Codex wrapper can follow the same manifest consumption rules
later.

## CLI Setup

This skill expects the `trace` command to be reachable on `PATH`. From the repo,
run `pnpm link --global` once; see `docs/usable-v1/cli-link.md`.

For tests or local debugging, set `TRACE_BIN` to an alternate command, for
example:

```sh
TRACE_BIN="node apps/cli/src/trace.ts" node .claude/skills/trace/trace-skill.mjs re-enter "checkout"
```
