## `archive-api` — 2026-06-04 21:57:07 CEST

**Status:** done
**Summary:** Added the archive data-layer lifecycle: `archivedAt` is now part of `Task` and `TaskSummary`, persisted through an additive `archived_at` migration, and exposed by `TaskStore.archiveTask` / `TaskStore.unarchiveTask` by id or slug. Added web data helpers and `POST /api/tasks/{ref}/archive` plus `POST /api/tasks/{ref}/unarchive`, including 404 for unknown refs, 405 for non-POST methods, and archived state in list payloads.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape used elsewhere in the repo. The requested local curl demo could not bind a localhost dev server in this sandbox (`listen EPERM` on both the configured port and an alternate port); route behavior was verified through API middleware tests against an isolated database instead. Prettier cannot infer a parser for `.sql` migration files, so the new SQL migration was excluded from the formatting command.
**Handoff:** Verified with red/green focused core store tests for archive/unarchive by id and slug, `archivedAt` in summaries, unknown-ref errors, and migration on an existing database; focused web data and middleware tests for both endpoints, 404/405 responses, and list payload shape; full `@trace/core` test suite; full `@trace/web` test suite; `@trace/core` typecheck; `@trace/web` typecheck; `@trace/core` lint; `@trace/web` lint; and Prettier on touched TypeScript, Markdown, and JSON files.

## `ui-hide-and-archive` — 2026-06-04 22:00:21 CEST

**Status:** done
**Summary:** Updated the tasks page to hide archived tasks by default via a pure `visibleTasks` helper, count only visible tasks, and render the list from the active subset. Added an archive row action that posts to `/api/tasks/{slug}/archive`, applies the returned archived state to local task state, and lets the default visibility filter remove the row from view; styled the action to match the existing compact row controls.
**Deviations:** The requested `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing archive-task log shape. The browser manual loop was covered structurally with focused page/helper tests and web checks in this AFK iteration rather than a human-observed browser pass; a local Vite smoke attempt could not bind a localhost port in this sandbox (`listen EPERM`).
**Handoff:** Verified red/green with a focused `TasksPage` test for hiding archived tasks by default, focused archive helper POST coverage, and row archive button rendering. Final checks: `pnpm --filter @trace/web test -- TasksPage.test.tsx`; `pnpm --filter @trace/web check-types`; `pnpm --filter @trace/web lint`; full `pnpm --filter @trace/web test`; and Prettier on touched TypeScript, CSS, and Markdown files.

## `ui-show-archived` — 2026-06-04 22:05:10

**Status:** needs-review
**Summary:** Added the tasks-page show-archived checkbox, extended the pure `visibleTasks` helper to include archived rows when requested, and wired archived rows to render muted with an unarchive action. Added `unarchiveTask` for `POST /api/tasks/{slug}/unarchive` and local state updates so unarchived rows return to the default active list after the toggle is turned off.
**Deviations:** The slice explicitly has a human checkpoint, so the automated work is marked `needs-review` for the later browser UX pass rather than `done`.
**Handoff:** Verified red/green with focused `TasksPage` tests for show-archived filtering, unarchive POST coverage, and archived muted-row/unarchive rendering. Final checks: `pnpm --filter @trace/web test -- TasksPage.test.tsx`; full `pnpm --filter @trace/web test`; `pnpm --filter @trace/web check-types`; `pnpm --filter @trace/web lint`; `pnpm exec prettier --write apps/web/src/pages/TasksPage.tsx apps/web/src/pages/TasksPage.test.tsx apps/web/src/styles.css docs/archive-tasks/archive-tasks.tasks.md`; and `git diff --check`.

## `auto-unarchive` — 2026-06-04 22:08:03

**Status:** done
**Summary:** Updated `trace skill work-on-task` so resolving an existing archived task by exact title clears `archivedAt` before session binding. Added CLI coverage proving the resumed task is not duplicated and reappears in task summaries, while `trace skill re-enter` leaves archived tasks untouched.
**Deviations:** none.
**Handoff:** Verified red/green with focused archived-task CLI tests, then full `@trace/cli` tests, `@trace/cli` typecheck, `@trace/cli` lint, and Prettier on touched files. The only behavior change is in the title-resolved `work-on-task` path; `re-enter` remains read-only for archive state.
