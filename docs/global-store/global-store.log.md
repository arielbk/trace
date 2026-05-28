# Global Store — Iteration Log

## global-default-path — 2026-05-28

**Slice:** `global-default-path` — Global default DB path with first-run bootstrap

**Status:** done

**What was done:**

- Created `apps/cli/src/db-path.ts` exporting `resolveDbPath(env)` — returns `TRACE_DB` if set and non-empty, falls back to `{HOME}/.trace/trace.sqlite`, throws if both are absent.
- Updated `apps/cli/src/trace.ts` to call `resolveDbPath` instead of the old hard-fail on missing `TRACE_DB`.
- Created `apps/cli/src/db-path.test.ts` with 4 unit tests covering all resolver branches.
- Created `apps/cli/src/global-default-path.test.ts` with 1 integration test: `runTraceCli(["task", "list"], { HOME })` exits 0 and `~/.trace/trace.sqlite` exists after the call.

**Tests:** 5 passed (4 unit + 1 integration). TypeScript check clean.

**Notes:**

- The existing subprocess-based CLI tests (task-crud.test.ts etc.) fail in this Linux sandbox because `process.execPath` can't run `.ts` files without a loader. That is a pre-existing environment issue unrelated to this slice. Integration tests for this slice use `runTraceCli` directly to avoid the subprocess loader problem.
- Dependencies were reinstalled (pnpm install after adding gcc/g++ for better-sqlite3 native build).

## project-root-resolver — 2026-05-28

**Slice:** `project-root-resolver` — Walk-up-to-git-root helper

**Status:** done

**What was done:**

- Added `packages/core/src/project-root.ts` exporting `resolveProjectRoot(cwd)`.
- Exported `resolveProjectRoot` from `@trace/core`.
- Added `packages/core/src/project-root.test.ts` covering nested repo resolution, cwd at repo root, no repo fallback, and `.git` file worktree markers.

**Tests:** `pnpm --filter @trace/core check-types` passed. Direct Node smoke for the four resolver behaviours passed.

**Notes:**

- `pnpm --filter @trace/core test -- project-root.test.ts` could not start Vitest because the local install is missing the optional native package `@rolldown/binding-darwin-arm64`. `pnpm install --offline` and `pnpm install` were attempted; the registry is unreachable from this sandbox, so the binary could not be restored here.

## `task-project-stamp` — 2026-05-28 22:48:34

**Status:** done
**Summary:** Added the `tasks.project_root` column, typed it through `Task`, and made CLI task creation stamp the nearest git root via `resolveProjectRoot(cwd)`. `trace task show` and `skill re-enter` now surface `projectRoot`.
**Deviations:** `drizzle-kit generate` could not run because the installed `esbuild` binary targets the wrong platform, so the migration SQL and snapshot metadata were produced manually and validated structurally.
**Handoff:** Focused typechecks pass for `@trace/core` and `@trace/cli`; fresh and existing schema migration SQL was validated with `/usr/bin/sqlite3`. Vitest still cannot start because `@rolldown/binding-darwin-arm64` is missing, and direct store runtime is blocked by a Linux `better-sqlite3` binary; `pnpm install` and `pnpm rebuild better-sqlite3` were attempted but cannot fetch Darwin packages/Node headers without network.
