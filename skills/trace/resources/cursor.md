# Trace in Cursor

This is the Cursor binding flow for the `trace` skill. The shared verbs
(`work-on-task`, re-entry) live in `../SKILL.md`; this file covers what is
specific to Cursor.

Cursor has no session-start hook, so there is no "no active task" nudge. Bind
when the user asks to work on, track, resume, re-enter, or continue a task.

## Session inference

Cursor exposes no session env var. The CLI resolves the current Cursor session
from the **directory the command runs in**: it maps the cwd to the focused GUI
composer or the newest `cursor-agent` (CLI) chat for that project — whichever
was touched most recently. Always run trace commands from the project
directory, not from an unrelated cwd, or the wrong (or no) session resolves.

Capture is pull-time: each skill verb that binds or re-enters
(`skill work-on-task`, `skill re-enter`) registers the resolved Cursor session
as it runs — no backfill scan and no hook needed. Everything else — creating or
resolving the task, `--description`, `--project`, and re-entry via the
`trace-reenter` skill — is identical to the shared flow.
