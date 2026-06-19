# Trace in Codex

This is the Codex binding flow for the `trace` skill. The shared verbs
(`work-on-task`, re-entry) live in `../SKILL.md`; this file covers what is
specific to Codex.

Codex has no session-start hook, so there is no "no active task" nudge. Bind
when the user asks to work on, track, resume, re-enter, or continue a task.

## Backfill Codex sessions first

Before binding or re-entering, backfill Codex sessions so the current and recent
Codex threads exist in the Trace store:

```sh
npx @arielbk/trace@0.6.0 session scan --codex
```

This uses `CODEX_HOME` when set, otherwise `$HOME/.codex`. Run it once at the
start of the binding flow, then proceed to the **We're working on X** verb in
`../SKILL.md`.

## Session inference

The CLI infers the current Codex thread from `CODEX_THREAD_ID` and the
transcript from `CODEX_TRANSCRIPT_PATH` when present. Everything else — creating
or resolving the task, `--description`, `--project`, and re-entry via the
`trace-reenter` skill — is identical to the shared flow.
