# QA Plan: Doc-Only Task Capture

Checked items were verified by running the automated suites. Unchecked items are
human-only end-to-end checks (each a self-contained runbook).

## Automated (verified)

- [x] `task create --help` prints usage and creates no task; `task create --oops`
      exits non-zero with `Usage:` and creates no task.
      `pnpm --filter @trace/cli test` → `task-crud.test.ts`.
- [x] `task capture <title> --doc <file>` creates a task, copies the file into
      `~/.trace/tasks/<id>/docs/<basename>`, and `task timeline --json` shows one
      `doc` item with `tokenTotals.totalTokens === 0`.
- [x] `task capture <title>` (no `--doc`) reads stdin into `capture.md`.
- [x] `task capture <title> --doc <file> --link` creates the `docs/<slug>`
      symlink and is idempotent on re-run.
- [x] `TaskTimelineView` renders a sessionless doc-only task (one doc item, zero
      token totals) without an empty-state or crash.
      `pnpm --filter @trace/web test` → `TaskPage.test.tsx`.
- [x] Lint + types clean: `pnpm --filter @trace/cli lint && pnpm --filter @trace/cli check-types`
      and the same for `@trace/web`.

## Human verification (manual)

- [ ] **Capture from a real repo, file path + symlink.**
  ```sh
  cd <a git repo on your machine>
  echo "# Flaky login test\n\nRetries flake under CI load." > /tmp/findings.md
  trace task capture "Fix flaky login test" --doc /tmp/findings.md --link
  ```
  Expect: a UUID printed. Then confirm:
  ```sh
  ls -l docs/fix-flaky-login-test        # symlink → ~/.trace/tasks/<id>/docs
  cat docs/fix-flaky-login-test/findings.md
  trace task timeline <id> --json | jq '{items: (.items | length), totals: .tokenTotals.totalTokens, type: .items[0].type}'
  ```
  Expect: `items: 1`, `totals: 0`, `type: "doc"`. Re-run the same capture command
  and confirm it does not error and `docs/fix-flaky-login-test` is still a single
  symlink.

- [ ] **Capture from stdin (agent-style park).**
  ```sh
  printf '## Idea\n\nExtract the parser into its own module.\n' | trace task capture "Park parser refactor"
  ```
  Expect a UUID; then `cat ~/.trace/tasks/<id>/docs/capture.md` shows the piped
  text, and `trace task show <id>` lists the doc with no sessions.

- [ ] **Web UI renders the captured task.** Start the web app:
  ```sh
  cd apps/web && pnpm dev      # vite dev server on http://localhost:3000
  ```
  Visit `http://localhost:3000`, open the captured task from the list, and
  confirm the timeline shows a single `doc` entry, the token totals read `0`,
  and there is no "No timeline items found." empty state.

- [ ] **Re-entry feeds capture into work.** After capturing a task, run
  `trace skill re-enter "<that title>"` and confirm the manifest lists the doc
  under `docs:` and `sessions: []`, ready to be picked up by `work-on-task`.
