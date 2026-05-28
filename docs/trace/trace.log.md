# Trace Implementation Log

## 2026-05-28 — `monorepo-task-crud`

**Status:** done

**Changed:**

- Added `packages/core` with a task store interface backed by a persistent SQLite database in WAL mode.
- Added `apps/cli` with `trace task create`, `trace task show`, and `trace task list`.
- Added outside-in tests for CLI create/show/list persistence and core store round-trip persistence.

**Feedback loop:**

- `node --test packages/core/src/task-store.test.ts apps/cli/src/task-crud.test.ts`
- `./node_modules/.bin/tsc --noEmit -p packages/core/tsconfig.json`
- `./node_modules/.bin/tsc --noEmit -p apps/cli/tsconfig.json`

**Notes:**

- Network access was unavailable, so Drizzle and `better-sqlite3` could not be fetched into the lockfile. The store uses Node 24's built-in `node:sqlite` API for the same local SQLite/WAL behavior and keeps the store boundary isolated for a later driver swap.

## `session-register-assign` — 2026-05-28 19:10:04

**Status:** done
**Summary:** Added persistent session registration and task assignment in core, plus CLI commands for `trace session register`, `trace session assign`, and `trace session list --unassigned`. Assigned sessions now appear under `trace task show`.
**Deviations:** Used the existing Node 24 `node:sqlite` store boundary from the prior slice rather than adding Drizzle or `better-sqlite3`.
**Handoff:** Sessions are stored once by `id`; assignment is a single nullable `task_id` update, so reassigning a session moves it rather than creating duplicate task links. Valid tools are constrained to `claude` and `codex`.

## `claude-code-adapter` — 2026-05-28 19:13:13

**Status:** done
**Summary:** Added a Claude Code JSONL transcript adapter that extracts the session id, transcript path, and token totals. Added a SessionStart hook script that reads Claude hook JSON from stdin and registers the session through the existing CLI path as an unassigned `claude` session.
**Deviations:** none.
**Handoff:** The hook expects Claude Code's common `session_id`, `transcript_path`, and optional `hook_event_name: "SessionStart"` fields on stdin. Token totals are parsed from top-level `usage` and `message.usage` objects in the transcript. Verified with core/CLI tests plus core and CLI typechecks.

## `codex-adapter` — 2026-05-28 19:17:49

**Status:** done
**Summary:** Added a Codex JSONL transcript adapter that validates `thread.started` identity against the transcript filename and optional live `$CODEX_THREAD_ID`, parses `turn.completed` token usage, and scans Codex homes via `session_index.jsonl` or `sessions/**/*.jsonl`. Added `trace session scan --codex --codex-home <path>` to backfill discovered sessions as unassigned `codex` sessions.
**Deviations:** Token totals are parsed and exposed by the adapter, but the existing store schema still only persists session identity, transcript path, tool, and task assignment.
**Handoff:** Verified with adapter unit tests, a CLI scan smoke test against a temporary Codex home fixture, existing core/CLI tests, and core/CLI typechecks.

## `doc-association` — 2026-05-28 19:20:31

**Status:** done
**Summary:** Added task-scoped document associations in core, including add/list/remove support backed by a `task_docs` SQLite table. Added `trace task add-doc <task> <path>` and extended `trace task show` to list associated docs.
**Deviations:** none.
**Handoff:** Verified with core doc association tests, CLI `add-doc` -> `show` integration coverage, and core/CLI typechecks.

## `timeline-rollup` — 2026-05-28 19:25:39

**Status:** done
**Summary:** Added persisted session token totals and a core `getTaskTimeline` rollup that returns a task's ordered sessions and docs with summed token totals. Added `trace task timeline <id> --json` plus token flags on `session register` so CLI-created sessions can contribute usage data.
**Deviations:** The existing SQLite store remains on Node's built-in `node:sqlite`; token columns are added with lightweight `ALTER TABLE` migration defaults for existing databases.
**Handoff:** `scan --codex` now persists parsed token totals into sessions. Timeline JSON includes `{ task, items, tokenTotals }`; items are `session` or `doc` entries sorted by `createdAt` with deterministic tie-breaking.

## `skill-wrapper` — 2026-05-28 19:28:57

**Status:** done
**Summary:** Added `trace skill work-on-task <task>` to register and assign a current or simulated session through the existing CLI/store path, plus `trace skill re-enter <task>` to emit task docs and prior-session references as lightweight context. Covered the scripted bind and re-entry round trip with a CLI smoke test.
**Deviations:** No live Claude Code or Codex dependency was introduced; the command supports explicit `--id`, `--transcript`, and `--tool` flags for CI, with lightweight env inference for `$CODEX_THREAD_ID` and Claude session variables.
**Handoff:** Verified with all core/CLI node tests, core and CLI typechecks, and Prettier checks for touched files.

## `web-view` — 2026-05-28 19:36:22

**Status:** done
**Summary:** Replaced the starter web page with a read-only Trace app: `/` lists tasks from the shared core store and `/task/:id` renders the task timeline with sessions, docs, and token totals. Added a web data adapter test that seeds SQLite and verifies the web adapter matches the core timeline.
**Deviations:** The sandbox rejects binding a local HTTP listener with `EPERM`, so the headless route smoke was covered by the adapter test plus Next typecheck, lint, and production build instead of a live fetch against `next dev`.
**Handoff:** Both routes force dynamic rendering so they read the current local SQLite store at request time. `TRACE_DB` is declared in `turbo.json`; without it the web app falls back to `.trace/trace.sqlite` relative to the app process.

## `drizzle-storage` — 2026-05-28 19:51:27

**Status:** done (initial iteration landed regression test only; follow-up landed the swap — see entry below)
**Summary:** Added a core regression test asserting the store opens in WAL mode and that the current schema migration path is idempotent across fresh and reopened databases.
**Deviations:** The actual Drizzle + `better-sqlite3` swap could not be completed in the codex iteration sandbox (offline registry, unwritable cached store). Superseded by the follow-up entry below.

## `drizzle-storage` — 2026-05-28 (follow-up: actual swap)

**Status:** done
**Summary:** Completed the dependency swap. `packages/core` now uses `better-sqlite3` as the driver and `drizzle-orm` for schema + queries, with a generated migration (`packages/core/drizzle/0000_*.sql`) applied via `drizzle-orm/better-sqlite3/migrator.migrate()` on store open. Schema lives in `src/schema.ts`; store implementation moved to `src/store.ts`; public types extracted to `src/types.ts`. The `TaskStore` interface and `openTraceStore` factory are unchanged. The interim `node:sqlite` implementation and the local `node-sqlite.d.ts` shim are removed.
**Deviations:** none.
**Handoff:** `drizzle-kit` is a `devDependency` of `@trace/core` for regenerating migrations. The WAL/migration regression test was updated to inspect via `better-sqlite3` and to ignore the `__drizzle_migrations` bookkeeping table. Verified with `node --test packages/core/src/*.test.ts apps/cli/src/*.test.ts` and core/CLI typechecks.
