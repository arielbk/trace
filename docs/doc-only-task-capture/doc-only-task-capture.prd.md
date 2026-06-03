# PRD: Doc-Only Task Capture

## Problem Statement

While working on one task, you routinely surface findings that belong to a *different* piece of work — a bug you noticed, a follow-up feature, a design decision worth recording. Today there's nowhere in trace to put them: you'd have to manually run `trace task create`, find the new task's docs directory, write a file into it, and symlink it into the repo. In practice the findings end up in the current task's docs or in chat history, and the future task starts from nothing. The primitives all exist (`task create`, `task add-doc`, the `docs/{feature}` → task-docs symlink convention) — what's missing is the one-shot flow.

## Solution

A single capture command that creates a new task with a document attached and no sessions: `trace task capture <title> [--doc <path> | stdin]` (final shape per implementation). It creates the task, writes or copies the findings doc into the task's docs directory, and optionally creates the repo-side `docs/{slug}` symlink. The result is a task whose timeline starts with just a doc — visible in the web UI and CLI like any other task — ready to be picked up later by `work-on-task`. An agent can then be told mid-session: "park these findings as a new trace task," and do it in one command.

## User Stories

1. As a trace user, I want to capture findings as a new task with an attached doc in one command, so that side-discoveries don't pollute the current task or get lost.
2. As an agent working a task, I want a one-shot way to park out-of-scope findings into a new trace task, so that the user can say "put that down somewhere else" and trust it landed.
3. As a trace user, I want doc-only tasks to render correctly in the web UI (timeline with a single doc entry, zero token totals), so that captured work is visible alongside active work.
4. As a trace user, I want the capture flow to optionally create the repo `docs/` symlink, so that the doc is reachable from the project like other task docs.
5. As a trace user, I want to later start work on a captured task with the existing re-entry/work-on-task flow, so that capture feeds directly into execution.

## Implementation Decisions

- Build on existing store/CLI primitives: task creation plus doc registration in one command; no new storage concepts.
- Accept doc content via file path or stdin; write into the task's docs directory under `~/.trace/tasks/`.
- Symlink creation is opt-in (flag) since not every captured task belongs to the current repo; when used, it follows the existing `docs/{feature}` convention.
- CLI argument parsing must reject flag-looking titles — discovered 2026-06-03 when `trace task create --help` created a real task titled `--help`. Fix this in `task create` as part of this work since capture shares the parsing path.
- Verify the web timeline and `task timeline` CLI handle sessionless tasks gracefully (they should already; add the test).

## Testing Decisions

- Store/CLI test: capture creates task + doc atomically, timeline shows one doc entry, token totals are zero.
- Argument-parsing test: flag-looking titles are rejected with usage output (`--help` shows help, doesn't create a task).
- Symlink flag test: link created, idempotent on re-run.

## Out of Scope

- Slug naming (covered by `docs/task-slugs/`; capture benefits automatically once it lands).
- Any automatic detection of "this finding belongs elsewhere" — capture is always explicit.
- Editing or appending to docs on existing tasks beyond what `add-doc` already does.
