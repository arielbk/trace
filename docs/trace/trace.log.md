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
