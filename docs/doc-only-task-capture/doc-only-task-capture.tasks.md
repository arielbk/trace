# Tasks: Doc-Only Task Capture

Vertical slices forming a DAG. Each is independently testable and ends green.

## Slice 1 — Reject flag-looking titles in `task create`
**Depends on:** none
Fix the bug where `trace task create --help` creates a task titled `--help`.
`task create` (and the shared title-parsing path) must reject titles that start
with `-`; `--help`/`-h` print usage instead of creating a task.

- API sketch: `trace task create --help` → exit non-zero (or 0 for help) with
  usage text on stderr/stdout; no task created. `trace task create -- --weird`
  still allowed via `--` terminator? (Out of scope — keep simple: any leading
  `-` token as the first title word is rejected unless it is a help flag.)
- Feedback loop: `cd apps/cli && pnpm test` (new test in `task-crud.test.ts`),
  `pnpm lint`, `pnpm check-types`.

## Slice 2 — `task capture` writes a doc from a file path
**Depends on:** Slice 1 (shares title parsing)
`trace task capture <title> --doc <path>` creates a task, copies the file into
the task's docs dir under `~/.trace/tasks/<id>/docs/`, registers nothing extra
(native doc discovery picks it up), and prints the task id. One doc timeline
entry, zero token totals.

- API sketch: `trace task capture "Fix flaky test" --doc ./findings.md` →
  prints task id; `trace task timeline <id> --json` shows one doc item and
  `tokenTotals.totalTokens === 0`.
- Feedback loop: `cd apps/cli && pnpm test`, `pnpm lint`, `pnpm check-types`.

## Slice 3 — `task capture` reads doc content from stdin
**Depends on:** Slice 2
`trace task capture <title>` with no `--doc` reads doc body from stdin and
writes it to a default filename (e.g. `capture.md`) in the task docs dir.

- API sketch: `echo "## findings" | trace task capture "Fix flaky test"` →
  task with one doc whose contents match stdin.
- Feedback loop: `cd apps/cli && pnpm test`, `pnpm lint`, `pnpm check-types`.

## Slice 4 — `--link` opt-in repo symlink, idempotent
**Depends on:** Slice 2
`trace task capture <title> --doc <path> --link` also creates the repo-side
`docs/<slug>` → task-docs-dir symlink following the existing convention, using
the resolved project root. Re-running with `--link` is idempotent (no error if
the link already points at the right target).

- API sketch: after capture with `--link`, `docs/<slug>` is a symlink to
  `~/.trace/tasks/<id>/docs`; second run does not throw and leaves one link.
- Feedback loop: `cd apps/cli && pnpm test`, `pnpm lint`, `pnpm check-types`.

## Slice 5 — Sessionless task renders gracefully (web + CLI)
**Depends on:** Slice 2
Add a regression test that `TaskTimelineView` (web) and `task timeline --json`
(CLI) render a doc-only / sessionless task with zero token totals. Likely
already works; lock it in.

- Feedback loop: `cd apps/web && pnpm test`; `cd apps/cli && pnpm test`.
