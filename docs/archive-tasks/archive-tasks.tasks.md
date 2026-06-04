# Archive tasks

Soft-delete lifecycle for tasks: archive/unarchive from the web UI with archived
tasks hidden by default behind a "Show archived" toggle, and auto-unarchive when
an agent resumes work on an archived task via `work-on-task`. See
`archive-tasks.prd.md` for full context.

## Slices

### `archive-api` — Archive/unarchive through the data layer

**Status:** done

**Outside-in:** `POST /api/tasks/{ref}/archive` and `POST /api/tasks/{ref}/unarchive` (ref = id or slug) return the updated task with `archivedAt` set/cleared; 404 for unknown refs, 405 for non-POST. `GET /api/tasks` summaries carry `archivedAt: string | null`. Underneath: `archived_at` migration (nullable text, additive ALTER following the existing pattern) and `archiveTask`/`unarchiveTask` on the `TaskStore` interface.

**Feedback loop:** Store tests: archive/unarchive round-trip by id and by slug, `archivedAt` in summaries, unknown-ref errors, migration applies to an existing database. API-handler tests: both POST endpoints (200/404/405) and `archivedAt` present in the list payload. Demo: curl the endpoints against a local db.

**Human checkpoint:** no

**Depends on:** none

### `ui-hide-and-archive` — Hide archived by default, archive button on rows

**Status:** done

**Outside-in:** The tasks page (`/`) renders only tasks with `archivedAt === null`; each active task row gets an archive button that POSTs to the archive endpoint and removes the row from view.

**Feedback loop:** Unit test on a pure visibility-filter function (alongside the existing grouping helpers in the web app). Manual: archive a task in the browser, row disappears, task count updates, row stays gone on reload.

**Human checkpoint:** no

**Depends on:** archive-api

### `ui-show-archived` — Show-archived toggle with unarchive

**Status:** needs-review

**Outside-in:** A "Show archived" toggle on the tasks page reveals archived tasks greyed out (reuse the muted-row treatment used for untitled tasks); each archived row gets an unarchive button that POSTs to the unarchive endpoint and restores the row to the active view.

**Feedback loop:** Unit test: visibility filter includes archived tasks when toggled. Manual: full loop in the browser — archive → toggle on → greyed row visible → unarchive → row back in default view.

**Human checkpoint:** yes — eyeball the archive→toggle→unarchive UX before closing out.

**Depends on:** ui-hide-and-archive

### `auto-unarchive` — Resumed work resurrects archived tasks

**Status:** not-started

**Outside-in:** `trace skill work-on-task "<title>"` resolving an existing archived task by exact title clears `archived_at` before binding the session — no duplicate task, and the task reappears in the default web list. `trace skill re-enter` does NOT unarchive.

**Feedback loop:** CLI skill tests: work-on-task against an archived task clears `archivedAt` and binds the session to the existing task id; re-enter against an archived task leaves `archivedAt` set.

**Human checkpoint:** no

**Depends on:** archive-api
