# Implementation Log: Doc-Only Task Capture

## Slice 1 — Reject flag-looking titles in `task create`
- Red: added two CLI tests in `apps/cli/src/task-crud.test.ts` — `task create --oops`
  must exit non-zero with `Usage:` and create no task; `task create --help` must
  print usage (success exit) and create no task.
- Green: in `apps/cli/src/trace.ts`, `task create` now checks `isHelpFlag` first
  (prints `taskCreateUsage()`), then `rejectFlagTitle` (any leading `-` token →
  usage failure). Updated the top-level `usage()` to advertise `capture`.
- Refactor: extracted shared `isHelpFlag` / `looksLikeFlag` / `rejectFlagTitle`
  so `capture` reuses the same guard.

## Slice 2 — `task capture --doc`
- Red: CLI test asserts `task capture <title> --doc <file>` prints a UUID, copies
  the file into `~/.trace/tasks/<id>/docs/<basename>`, and that
  `task timeline --json` shows exactly one `doc` item with `tokenTotals.totalTokens === 0`.
- Green: added the `capture` action to `trace.ts`. It parses args via
  `parseTaskCaptureArgs`, creates the task, `mkdirSync`s the docs dir
  (`resolveTaskDocsDir`), and `copyFileSync`s the source doc. Native doc
  discovery (existing `listNativeTaskDocs`) surfaces it on the timeline — no new
  storage concept. Sessionless ⇒ zero token totals fall out of the existing
  reduce.

## Slice 3 — `task capture` from stdin
- Red: CLI test pipes content via `input:` with no `--doc`; expects a
  `capture.md` doc whose contents match stdin.
- Green: when `--doc` is absent, capture reads fd 0 (`readFileSync(0, "utf8")`)
  and writes `capture.md` into the docs dir.

## Slice 4 — `--link` opt-in repo symlink, idempotent
- Red: CLI test runs capture twice with `--link` inside a `.git` repo; expects
  `docs/<slug>` to be a symlink to the task docs dir, and re-run to not throw and
  re-point at the latest capture.
- Green: `linkRepoDocs` slugifies the title, ensures `docs/` exists, and
  `symlinkSync`s to the docs dir. If a symlink already sits at the path it is
  left alone when it already points at the target, otherwise replaced (idempotent);
  a non-symlink at the path is a hard error.

## Slice 5 — Sessionless rendering (web + CLI)
- Web: added a `TaskTimelineView` test in `apps/web/src/pages/TaskPage.test.tsx`
  for a doc-only timeline (one doc item, all-zero token totals) — renders the doc
  tag, no empty-state, no crash. CLI side is covered by the Slice 2 timeline
  assertion. Core already had an empty/sessionless timeline test, so no new core
  test was needed.

## Build
- Re-ran `node src/build.ts` in `apps/cli` to regenerate the shipped bundles
  (`bin/trace.js`, `apps/cli/dist/trace.js`, and the session-start-hook bundle,
  which inlines the CLI module) so the plugin ships the `capture` command.

## Feedback loops (all green)
- `pnpm --filter @trace/cli test` (40 passed)
- `pnpm --filter @trace/core test` (58 passed)
- `pnpm --filter @trace/web test` (6 passed)
- `pnpm --filter @trace/cli lint` / `check-types`, `pnpm --filter @trace/web lint` / `check-types`
