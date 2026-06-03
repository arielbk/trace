# Task Slugs — QA Plan

Legend: `[x]` verified by running during implementation; `[ ]` human-only check
with a self-contained runbook.

## Automated (verified)

- [x] Slug derivation unit tests (casing, punctuation, unicode transliteration,
  digits, whitespace/underscore collapse, leading/trailing trim, length cap,
  empty fallback, placeholder slug). `pnpm --filter @trace/core test slug`
- [x] Slug column, unique index, derivation in `createTask`, collision suffixing
  (`checkout`, `checkout-2`, `checkout-3`), placeholder slug for untitled tasks.
  `pnpm --filter @trace/core test`
- [x] Migration backfills slugs for pre-existing rows with collision handling and
  records the new `slug` column. `pnpm --filter @trace/core test`
- [x] `getTaskByRef` resolves by UUID then slug and misses cleanly; timeline /
  manifest / add-doc / assign all accept slugs. `pnpm --filter @trace/core test`
- [x] New tasks read native docs from their slug-named directory; legacy
  UUID-named directories still resolve via fallback.
  `pnpm --filter @trace/core test`
- [x] CLI: `task create`/`task list` emit slugs; `task show` prints slug + UUID;
  slugs accepted by `show`/`add-doc`/`timeline`/skill verbs; `work-on-task`
  prints slug-based `taskDocsDir`. `pnpm --filter @trace/cli test`
- [x] CLI bundle rebuilt and bundle smoke test passes.
  `pnpm --filter @trace/cli build && pnpm --filter @trace/cli test bundle`
- [x] Web: `TaskList` shows and links by slug; `TaskPage` shows slug.
  `pnpm --filter @trace/web test`
- [x] Full lint + type-check across all packages.
  `pnpm -r lint && pnpm -r check-types`

## Human verification

- [ ] End-to-end CLI on a real store. From the repo root:
  ```sh
  export TRACE_DB="$(mktemp -d)/trace.sqlite"
  node apps/cli/src/trace.ts task create "Manual Break Start & Sounds"
  # expect: manual-break-start-sounds
  node apps/cli/src/trace.ts task list
  # expect a line: manual-break-start-sounds\tManual Break Start & Sounds
  node apps/cli/src/trace.ts task show manual-break-start-sounds
  # expect: slug:, id: <uuid>, title:, createdAt:, projectRoot:
  node apps/cli/src/trace.ts task create "Manual Break Start & Sounds"
  # expect a suffixed slug: manual-break-start-sounds-2
  ```

- [ ] Slug-named docs directory is real on disk. Continuing from above:
  ```sh
  node apps/cli/src/trace.ts skill work-on-task "Manual Break Start & Sounds" \
    --id sess-1 --transcript /tmp/sess-1.jsonl --tool claude
  # note the printed taskDocsDir — it should end in
  #   tasks/manual-break-start-sounds/docs
  ls -d "$(dirname "$TRACE_DB")/tasks/manual-break-start-sounds" 2>/dev/null \
    || echo "dir is created lazily when docs are written"
  ```
  Then create a doc under that directory and confirm `task show
  manual-break-start-sounds` lists it under `docs:`.

- [ ] Legacy UUID directory still resolves (dual-resolve). Create a fresh store,
  create a task, find its UUID via `task show <slug>` (the `id:` line), write a
  file into `tasks/<uuid>/docs/legacy.md` (NOT the slug dir), and confirm
  `task show <slug>` still lists `legacy.md` under `docs:`.

- [ ] Existing real `~/.trace/trace.sqlite` migrates cleanly. Back it up first,
  then run any `trace` command against it and confirm tasks list with slugs and
  no errors:
  ```sh
  cp ~/.trace/trace.sqlite ~/.trace/trace.sqlite.bak
  node apps/cli/src/trace.ts task list   # uses your real ~/.trace DB
  ```
  Confirm every pre-existing task shows a readable slug (titled tasks get a
  title-derived slug; untitled ones get `task-<short-id>`).

- [ ] Web UI shows slugs. Start the dev server (port 3000):
  ```sh
  pnpm --filter @trace/web dev
  ```
  Open http://localhost:3000 and confirm the tasks list shows the slug (not a
  truncated UUID) beside each title. Click a task: the URL becomes
  `/task/<slug>`, the page loads its timeline, and the header shows the slug
  under the title.
