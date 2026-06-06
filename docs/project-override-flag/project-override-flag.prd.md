# PRD: Project override flag

## Problem Statement

The project a task belongs to is always inferred from the CLI's current working directory (nearest `.git` ancestor). When the agent runs from a parent directory spanning multiple projects — e.g. a sandbox directory opened so the agent can reach several repos — there is no way to assign a task to the project it actually concerns. Tasks get keyed to the sandbox's project root, and recall from the same vantage point can't find tasks that were correctly keyed to the real project.

## Solution

A `--project <dir>` flag on every project-resolving CLI command. When present, the given directory (resolved against cwd if relative) is passed through the existing `resolveProjectRoot` instead of cwd. When absent, behavior is exactly as today. A nonexistent directory is a hard error — failing loud prevents typo'd paths from silently keying tasks to phantom project roots. The trace and recall skills are updated so the agent defaults to cwd but passes `--project` with the directory of the project it's actually working in when that differs.

## User Stories

1. As an agent working from a multi-project sandbox directory, I want to create a task assigned to a specific project via `--project`, so that the task is keyed to the real project root rather than the sandbox.
2. As an agent binding a session via work-on-task, I want to pass `--project`, so that the session's task lands in the correct project.
3. As an agent capturing a task, I want to pass `--project`, so that captured tasks are keyed correctly regardless of where the CLI runs.
4. As a user asking to recall prior work on another project ("get back to that trace archiving thing") from outside that project's directory, I want recall candidates scoped by `--project`, so that the right tasks are found.
5. As an agent that typos a project path, I want the CLI to fail loudly with a clear error, so that tasks are never silently split across phantom project roots.
6. As a user running trace from inside a project as today, I want unchanged behavior when `--project` is omitted, so that nothing regresses.
7. As an agent reading the trace/recall skills, I want explicit instructions on when to pass `--project`, so that the flag actually gets used.

## Implementation Decisions

- **Resolution helper**: one shared function (living alongside `resolveProjectRoot` in the core package) that takes an optional project-dir argument and the cwd; it resolves relative paths against cwd, hard-errors if the directory does not exist, and otherwise delegates to `resolveProjectRoot(projectDir ?? cwd)`. Directories without a `.git` ancestor keep today's fallback (the passed path itself) — no new behavior.
- **Flag parsing**: `--project <dir>` parsed in the CLI's existing manual flag-loop style (same pattern as `--description`), added to the four project-resolving commands: `task create`, `task capture`, `skill work-on-task`, `skill recall-candidates`.
- **Error contract**: nonexistent directory → non-zero exit with a message naming the bad path, so a driving agent can retry with the correct one.
- **Skill updates**: `skills/trace/SKILL.md` and `skills/recall/SKILL.md` gain a short instruction: default to cwd; if the work clearly lives in a different project than the CLI's working directory, pass `--project <dir of that project>`. Example invocations in both skills show the flag.
- **No schema changes**: `project_root` storage is untouched; the flag only changes what value flows into it.

## Testing Decisions

- **Unit tests** (Vitest, colocated like `project-root.test.ts`): the resolution helper — flag absent falls back to cwd; relative path resolves against cwd; nonexistent path throws; git-less existing dir returns the dir itself (parity with today's fallback).
- **CLI integration tests** (following the `execFileSync` pattern in the existing task CRUD tests): `task create --project <other repo>` from an unrelated cwd stores the other repo's root as `project_root`; `skill recall-candidates --project <other repo>` returns that task while plain invocation from the unrelated cwd does not; nonexistent `--project` exits non-zero.
- Skill markdown changes are not tested mechanically.

## Out of Scope

- A project *name* registry, aliases, or fuzzy matching — the agent resolves names to paths itself.
- A `TRACE_PROJECT` env var or any second override channel.
- Migrating or re-keying existing mis-filed tasks.
- New validation or behavior for directories without a `.git` ancestor.
- Board UI changes.
