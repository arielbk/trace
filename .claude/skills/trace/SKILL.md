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
current Claude Code session from `CLAUDE_SESSION_ID` or `session_id`, and the
transcript from `CLAUDE_TRANSCRIPT_PATH` when present. Pass `--model <name>`
when the model is known to record it on the session:

```sh
node .claude/skills/trace/trace-skill.mjs work-on-task "X" --model claude-opus-4-7
```

### Re-enter X

Resolve an existing task with the exact title `X`, then print its docs and prior
session references:

```sh
node .claude/skills/trace/trace-skill.mjs re-enter "X"
```

## CLI Setup

This skill expects the `trace` command to be reachable on `PATH`. From the repo,
run `pnpm link --global` once; see `docs/usable-v1/cli-link.md`.

For tests or local debugging, set `TRACE_BIN` to an alternate command, for
example:

```sh
TRACE_BIN="node apps/cli/src/trace.ts" node .claude/skills/trace/trace-skill.mjs re-enter "checkout"
```
