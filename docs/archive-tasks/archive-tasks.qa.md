# QA Plan: Archive tasks

## What was built

Tasks now have a soft-delete lifecycle: archive/unarchive through the store and web API, archived tasks hidden by default on the task list, a show-archived UI with muted archived rows and unarchive actions, and automatic unarchive when `trace skill work-on-task` resumes an archived task by exact title.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `archive-api` focused core store tests — archive/unarchive by id and slug, `archivedAt` in summaries, unknown-ref errors, and migration on an existing database passed.
- [x] `archive-api` focused web data and middleware tests — `POST /api/tasks/{ref}/archive`, `POST /api/tasks/{ref}/unarchive`, 404/405 responses, and list payload shape passed.
- [x] `pnpm --filter @trace/core test` — full `@trace/core` suite passed after the archive data-layer changes.
- [x] `pnpm --filter @trace/web test` — full `@trace/web` suite passed after the archive API changes and again after the hide-archived UI changes.
- [x] `pnpm --filter @trace/core check-types` — core TypeScript clean after archive API work.
- [x] `pnpm --filter @trace/web check-types` — web TypeScript clean after archive API, hide-archived, and show-archived work.
- [x] `pnpm --filter @trace/core lint` — core ESLint clean after archive API work.
- [x] `pnpm --filter @trace/web lint` — web ESLint clean after archive API, hide-archived, and show-archived work.
- [x] `pnpm --filter @trace/web test -- TasksPage.test.tsx` — focused tasks-page tests passed for hiding archived tasks by default, show-archived filtering, archive/unarchive POST helpers, archive button rendering, and muted archived-row/unarchive rendering.
- [x] `pnpm --filter @trace/cli test` — full `@trace/cli` suite passed after auto-unarchive work.
- [x] Focused archived-task CLI tests — `work-on-task` against an archived task clears `archivedAt` and binds to the existing task; `re-enter` leaves archived tasks archived.
- [x] `pnpm --filter @trace/cli check-types` — CLI TypeScript clean after auto-unarchive work.
- [x] `pnpm --filter @trace/cli lint` — CLI ESLint clean after auto-unarchive work.
- [x] `git diff --check` — whitespace check passed after show-archived work.
- [x] Prettier on touched TypeScript, CSS, Markdown, and JSON files — formatting completed for touched files; SQL migration formatting was intentionally excluded because Prettier cannot infer a `.sql` parser.

## Human verification required

Items from slices with `Human checkpoint: yes`, plus anything from the log that needs a human eye, browser, device, or judgement call. Each item is a runbook — exact commands, exact entry point, steps, and pass criterion. Never make the human figure out how to run the thing.

### Setup

Run once from the repo root. This uses an isolated QA database so the archive/unarchive loop does not mutate your normal `~/.trace/trace.sqlite`.

```bash
cd /Users/arielbk/Projects/side/trace-v2
pnpm install        # only if dependencies are not already installed
export TRACE_DB=/private/tmp/trace-archive-tasks-qa.sqlite
rm -f "$TRACE_DB"
node apps/cli/src/trace.ts task create "archive tasks QA active task"
pnpm --filter @trace/web dev
```

The Vite dev server is configured in `apps/web/vite.config.ts` to serve the app and API on `http://localhost:3000`.

- [ ] **Show archived and unarchive browser loop** (slice `ui-show-archived`, `Status: needs-review`, `Human checkpoint: yes`)
  - Run: use the server from Setup.
  - Open: `http://localhost:3000/`.
  - Do: find the row titled `archive tasks QA active task`; hover the row and confirm the relative time swaps to an archive icon at the row's right edge (rows show no archive control at rest); click the archive icon; confirm the row disappears and the task count decrements; reload `http://localhost:3000/`; confirm the archived row is still hidden; check `Show archived` (top-right of the page header); confirm the archived row appears muted/greyed; hover it and click the unarchive icon; uncheck `Show archived`.
  - Expect: the active row is hidden by default after archive, stays hidden after reload, appears only when `Show archived` is checked, uses the muted archived-row treatment, and returns to the default active list after unarchive with no duplicate row.

## Watch closely

Items where the log recorded deviations, snags, or unusual decisions. These are the most likely sources of subtle bugs — worth extra scrutiny during human verification.

- [ ] `archive-api`: the local `curl` demo could not run because the sandbox could not bind a localhost dev server (`listen EPERM` on the configured and alternate ports). API behavior was verified through middleware tests, but the browser run above is the first live localhost pass.
- [ ] `archive-api`: the new SQL migration was excluded from Prettier because Prettier cannot infer a parser for `.sql` migration files.
- [ ] `ui-hide-and-archive`: the manual archive-in-browser loop was covered structurally with focused page/helper tests rather than a human-observed browser pass; the sandbox again could not bind a local Vite port.
- [ ] `ui-show-archived`: the slice is intentionally `needs-review` because the task spec requires a human checkpoint for the archive -> toggle -> muted row -> unarchive UX.
