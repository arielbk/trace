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
