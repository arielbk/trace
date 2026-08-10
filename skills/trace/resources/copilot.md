# Trace in GitHub Copilot CLI

This is the GitHub Copilot CLI binding flow for the `trace` skill. The shared
verbs (`work-on-task`, re-entry) live in `../SKILL.md`; this file covers what is
specific to Copilot.

Copilot's `sessionStart` hook registers the live session before you begin work
and submits a nudge to consult Trace. Follow that nudge when the session is not
already bound: bind when the user asks to work on, track, resume, re-enter, or
continue a task.

## Session inference

Copilot exposes no session-id environment variable. The CLI finds the current
session by walking its ancestor PIDs and matching a live
`session-state/<id>/inuse.<pid>.lock` under `COPILOT_HOME` (or Copilot's default
home). Run Trace commands from inside the Copilot session so that lock can be
found. Do not pass a session id or transcript path unless recovering a known
exception.

The `agentStop` hook checks the bound task for state freshness when a turn ends.
Everything else — creating or resolving the task, `--description`, `--project`,
and re-entry via the `trace-reenter` skill — is identical to the shared flow.
