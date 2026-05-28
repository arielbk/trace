# Global Store QA Plan

## Already verified by the agent

- [x] `global-default-path`: 4 resolver unit tests + 1 integration test (`runTraceCli(["task","list"], { HOME })` creates `~/.trace/trace.sqlite`) passed.
- [x] `project-root-resolver`: `pnpm --filter @trace/core check-types` clean; direct Node smoke covered nested repo, repo-root cwd, no-repo fallback, and `.git`-file worktree marker.
- [x] `task-project-stamp`: focused typechecks pass for `@trace/core` and `@trace/cli`; migration SQL validated against both a fresh schema and a pre-existing `tasks` table via `/usr/bin/sqlite3`.
- [x] `web-cross-project-view`: post-loop `pnpm -r test` ran cleanly (30/30 across core, cli, web — incl. the new `data.test.ts` global-path case and `TasksPage.test.tsx` grouping case); `pnpm -r check-types` clean.

## Human verification required

### Setup

The CLI and web app should share the same store via the new global default — leave `TRACE_DB` **unset** so both resolve to `~/.trace/trace.sqlite`. If you already have a populated `~/.trace/trace.sqlite` from prior work, this exercises the cross-project view directly; otherwise create a couple of tasks from two different repos.

```bash
unset TRACE_DB

# From repo A (this repo)
cd /Users/arielbk/Projects/side/trace-v2
node apps/cli/src/trace.ts task create "global-store smoke A"

# From any other git repo on disk (repo B)
cd /path/to/some/other/git/repo
node /Users/arielbk/Projects/side/trace-v2/apps/cli/src/trace.ts task create "global-store smoke B"

# Confirm both stamped the right project root
node /Users/arielbk/Projects/side/trace-v2/apps/cli/src/trace.ts task list

# Start the web app — same global default
cd /Users/arielbk/Projects/side/trace-v2/apps/web && pnpm dev
```

- [x] **First-run bootstrap creates `~/.trace/trace.sqlite`** — with `TRACE_DB` unset and `~/.trace/` deleted, run `trace task list` and confirm the file is created and the command exits 0.
- [x] **`task create` stamps the resolved project root** — create a task from a nested subdirectory (e.g. `apps/web/src`) of a git repo and confirm `trace task show <id>` prints `projectRoot:` as the repo root, not the cwd.
- [x] **Web app reads the global store with no env vars** — start `apps/web` with `TRACE_DB` unset; the task list page renders tasks created via the CLI above without any extra config.
- [x] **Web task list groups tasks by project root** — with tasks from two different repos present, confirm the `/` page renders two sections, each headed by the project basename and showing the full project-root path, with the relevant tasks under each. (`web-cross-project-view` carries `Human checkpoint: yes`.)

## Human verification run (2026-05-29, agent-driven)

All four checks above PASS. Walkthrough, screenshots, and a screen recording
are in [`qa-artifacts/`](./qa-artifacts/) (see its `README.md`).

- **Check 1** — verified twice: a clean temp `HOME` (proves dir creation from
  nothing) and the real `~/.trace` (had no `trace.sqlite` yet). Both: exit 0,
  valid migrated SQLite with the `project_root` column (default `''`). The
  unrelated pre-existing `~/.trace/credentials.json` was left untouched (`~/.trace/`
  was *not* deleted, to avoid destroying it).
- **Check 2** — task created from `apps/web/src` stamped
  `projectRoot: /Users/arielbk/Projects/side/trace-v2` (the git root), not the cwd.
- **Checks 3 & 4** — `apps/web` started with `TRACE_DB` unset; `/` rendered two
  groups (`trace-v2`, `tmp-trace-repo-b`), each with the basename heading and
  full project-root path. See `qa-artifacts/global-store-grouped.png`.

### Code change made during the run

The PRD's path-resolution decision says a single helper in `@trace/core`
resolves the DB path and "Both the CLI and the web server consume this helper;
neither hard-codes a path." In practice the logic was **duplicated** in
`apps/cli/src/db-path.ts` (`resolveDbPath`) and `apps/web/src/server/data.ts`
(`getDatabasePath`) — identical today but free to drift. Extracted
`resolveDatabasePath(env)` into `packages/core/src/db-path.ts`, exported it from
`@trace/core`, and made both consumers delegate to it (public function names
kept, so callers/tests are unchanged). `pnpm -r check-types` clean;
`pnpm -r test` 30/30 (core 13, web 4, cli 13).

## Timeline / token aggregation run (2026-05-29, agent-driven)

Optional follow-up from [`global-store.handoff.md`](./global-store.handoff.md):
exercise the task **detail page** end-to-end (token aggregation + timeline),
which the two smoke tasks couldn't show because they had no sessions/docs.

Attached to task A (`b2466bc0…`, "global-store smoke A") via the CLI with
`TRACE_DB` unset (shared `~/.trace/trace.sqlite`):
- `session register/assign demo-claude-1` — claude, 1200 in / 800 out /
  400 cache-create / 2000 cache-read → 4400 total.
- `session register/assign demo-codex-1` — codex, 600 in / 1500 out → 2100 total.
- `task add-doc … global-store.prd.md`.

- [x] **CLI aggregation** — `task timeline … --json` returned `Total 6500 ·
  Input 1800 · Output 2300` (cache-create 400, cache-read 2000) and 3 items
  (2 sessions + 1 doc) sorted ascending by `createdAt`.
- [x] **`registerSession` idempotency** — re-registering `demo-claude-1` with
  the same id returned the existing row; item count stayed 3, total stayed 6500.
- [x] **Web detail page** — `apps/web` (on :3001; :3000 was busy) rendered
  `Total tokens 6500 / Input 1800 / Output 2300`, per-session breakdown
  (claude 4400, codex 2100), and the prd.md doc — all 3 timeline items in order.
- **Artifacts:** `qa-artifacts/global-store-timeline.webm` (19.4s recording),
  `qa-artifacts/global-store-timeline.png`.

> The demo sessions/docs persist in `~/.trace/trace.sqlite`. No `task delete`
> CLI exists; to reset, delete rows via `sqlite3` or remove `~/.trace/trace.sqlite*`.

## Watch closely

- `task-project-stamp` Deviation: `drizzle-kit generate` could not run in the sandbox (platform-mismatched `esbuild`), so `packages/core/drizzle/0001_task_project_root.sql` and its snapshot metadata were authored manually. Migration was validated by raw `sqlite3` against fresh + existing schemas, but a real run of `drizzle-kit` on your machine is a worthwhile sanity check before shipping. — **RESOLVED 2026-05-29:** ran on host — `drizzle-kit check` → "Everything's fine"; `drizzle-kit generate` → "No schema changes, nothing to migrate" with no files modified. The hand-authored migration matches `schema.ts` and the snapshot exactly.
- `web-cross-project-view` Deviation: Vitest/Vite could not start inside the sandbox because of a missing `@rolldown/binding-darwin-arm64` native binding; the slice was committed on typecheck + structural checks only. The native binding has since been restored on the host and `pnpm -r test` passes — but if you wipe `node_modules` and reinstall offline, the same gap can reappear.
- Across all slices the sandbox lacked network, so any time a log entry says "install attempted" it did not actually pull new packages; rely on the host's repaired install state.
