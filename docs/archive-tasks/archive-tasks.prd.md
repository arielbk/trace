# PRD: Archive tasks

## Problem Statement

Tasks in Trace only ever accumulate — there is no lifecycle state at all (no
status, completion, or deletion). As the first user keeps binding sessions to
new tasks, the web tasks list grows without bound and finished or abandoned
tasks clutter the view, making it harder to find what's actually live.

## Solution

A task can be archived from the web UI — a soft delete. Archived tasks
disappear from the default tasks list but remain in the database with all
their sessions and docs intact. A "Show archived" toggle reveals them,
greyed out, with an unarchive action. If an agent starts working on an
archived task again (via the `work-on-task` skill verb), the task
automatically unarchives — new activity means it wasn't done after all.

The web UI is the human surface and the only place archiving is exposed;
the CLI is the agent surface and is deliberately untouched.

## User Stories

1. As the user browsing the tasks list, I want to archive a task directly
   from its row, so that I don't have to jump to an agent or the CLI to
   declutter the view.
2. As the user browsing the tasks list, I want archived tasks hidden by
   default, so that the list only shows live work.
3. As the user, I want a "Show archived" toggle that reveals archived tasks
   greyed out, so that archiving feels safe and reversible rather than
   destructive.
4. As the user viewing archived tasks, I want an unarchive action on each
   archived row, so that a mis-click or a premature archive is recoverable
   in one click.
5. As the user, I want a task that an agent resumes work on (exact-title
   match through `work-on-task`) to automatically unarchive, so that new
   activity is never silently accrued on a hidden task and no duplicate
   task is created for the same title.
6. As an agent using the CLI, I want task commands to behave exactly as
   before, so that nothing in my workflow changes.

## Implementation Decisions

- **Schema**: add a nullable `archived_at` timestamp column to the tasks
  table via a new migration, following the existing additive
  `ALTER TABLE ... ADD` migration pattern. `NULL` means active; a value
  records when the task was archived. No backfill needed — existing rows
  are active by definition.
- **Store**: the `Task` (and therefore `TaskSummary`) type gains
  `archivedAt: string | null`. The `TaskStore` interface gains
  `archiveTask(ref)` and `unarchiveTask(ref)` (resolving by id or slug,
  matching `getTaskByRef` semantics). List methods keep returning all
  tasks including archived ones — filtering is a presentation concern.
- **Auto-unarchive**: the `work-on-task` CLI path, when it resolves an
  existing task by exact title, clears `archived_at` before binding the
  session. `re-enter` does not unarchive (reading context is not new work).
- **API**: the trace API router gains its first mutation endpoints —
  `POST /api/tasks/{ref}/archive` and `POST /api/tasks/{ref}/unarchive`,
  returning the updated task, 404 for unknown refs, and 405 for non-POST
  methods. No request body needed. The existing `GET /api/tasks` summary
  payload carries `archivedAt` so the client can filter; no query
  parameters are added.
- **Web UI**: the tasks page filters out archived tasks by default and
  gains a "Show archived" toggle. When shown, archived rows render greyed
  out (reusing the existing muted-row pattern from untitled tasks) with an
  unarchive button; active rows carry an archive button. The page
  re-fetches or locally updates after a mutation. The task detail page is
  untouched.

## Testing Decisions

- **Store**: extend the existing task-store test suite — archive/unarchive
  round-trip by id and by slug, `archivedAt` surfacing in summaries,
  unknown-ref errors, and migration of an existing database.
- **API handler**: extend the existing api-handler test suite — both POST
  endpoints (success, 404, 405), and `archivedAt` present in the
  `GET /api/tasks` payload.
- **work-on-task**: extend the existing CLI skill tests — binding to an
  archived task by exact title clears `archivedAt`; `re-enter` leaves it
  set.
- **Web**: the visibility filter is extracted as a pure function and
  unit-tested alongside the existing grouping helpers; no React component
  tests (none exist in the codebase today).

## Out of Scope

- CLI archive/unarchive commands, list flags, or status badges (`trace
  task list` and `show` keep returning/printing everything, unchanged).
- A separate archived page or route — visibility is a toggle on the
  existing tasks list.
- Task detail page changes (badges, archive/unarchive buttons there).
- Server-side filtering via query parameters.
- Any broader task lifecycle (done/in-progress states, hard delete).
