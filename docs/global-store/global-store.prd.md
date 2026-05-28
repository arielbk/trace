# PRD: Global Trace Store

## Problem Statement

Trace currently has no opinion about where its SQLite database lives. The web app falls back to `./.trace/trace.sqlite` relative to cwd, and the CLI requires `TRACE_DB` to be set explicitly. As a result, running `trace` in two different projects writes to two unrelated databases, the web UI can only see whichever project it was launched from, and there is no setup path — a first-time user gets an error instead of a working tool.

There is also no concept of a "project" on a task, so even if multiple projects' tasks landed in one database, the UI couldn't tell them apart.

## Solution

A single, global SQLite store at `~/.trace/trace.sqlite`, auto-created on first CLI use, with each task stamped at creation time with the git-root path of the directory it was created in. The web app reads from the same global store by default, giving a cross-project task view for free. `TRACE_DB` remains the only escape hatch for power users who want a project-local or otherwise custom DB; there is no `trace setup` command and no project-local mode as a first-class feature.

## User Stories

1. As a developer, I want to run a `trace` command in any project without configuration, so that I don't have to think about database paths or initialization.
2. As a developer, I want all my tasks across all my projects to live in one place, so that the web UI shows me everything I'm working on at once.
3. As a developer, I want the web UI to group tasks by project, so that the cross-project view stays legible as it grows.
4. As a developer, I want each task to remember which project it belongs to without me naming the project, so that there is no per-project setup step.
5. As a developer with an unusual setup, I want `TRACE_DB` to still work as an override, so that I can pin a project to its own DB if I really need to.

## Implementation Decisions

**Path resolution (single source of truth).** A small helper in `@trace/core` resolves the database path: `TRACE_DB` if set, otherwise `~/.trace/trace.sqlite`. Both the CLI and the web server consume this helper; neither hard-codes a path. The `./.trace/trace.sqlite` default in the web server is removed.

**First-run bootstrap.** On open, the store ensures `~/.trace/` exists (`mkdir -p`) and runs Drizzle migrations against the resolved path. No separate `setup` command — the CLI is usable on first invocation in any directory.

**Project identity (auto-derived).** A `project_root` text column is added to the `tasks` table. At task creation time, the CLI walks up from cwd to find a `.git` directory and uses that absolute path as the project root; if no `.git` is found, it falls back to cwd. The path is stored as-is; the UI derives a display name from the basename (last segment, or last two segments if needed to disambiguate). No project config file, no `trace project init`.

**Schema migration.** A new migration adds `project_root` to `tasks`. Existing rows (if any local databases exist) get backfilled to `NULL` or a sentinel; the UI treats missing project as an "unknown project" bucket. Sessions and docs inherit their project transitively via their task and do not need their own column.

**Web UI grouping.** The task list groups by `project_root`, with the display name as the group header. No filtering UI in this slice — grouping is enough to make the cross-project view usable.

**CLI surface unchanged otherwise.** No new commands. `task create` gains the implicit side effect of stamping `project_root`; everything else continues to work.

## Testing Decisions

- **Path resolver** — unit test: returns `TRACE_DB` when set, returns `~/.trace/trace.sqlite` (via `os.homedir()`) when not. Cover the empty-string case for `TRACE_DB`.
- **First-run bootstrap** — integration test: point `HOME` at a temp dir, open the store, assert `~/.trace/trace.sqlite` exists and is a valid migrated DB.
- **Project root detection** — unit test the walk-up logic with a fixture tree: a nested cwd inside a repo resolves to the repo root; a cwd outside any repo resolves to itself.
- **Task creation stamps project_root** — extend existing `task-crud.test.ts` (and `task-store.test.ts` in core) to assert the new column is populated.
- **Web data layer** — extend `apps/web/src/__tests__/data.test.ts` to confirm it reads from the resolved global path when `TRACE_DB` is unset.

Prior art: existing tests already manipulate `process.env.TRACE_DB` per-test; the same pattern extends to `HOME` for the bootstrap tests.

## Out of Scope

- **A `trace setup` command** — first-run is automatic; no explicit setup step.
- **Project-local `.trace/` as a first-class mode** — `TRACE_DB` is the only escape hatch.
- **Multi-DB aggregation** — the web app reads exactly one DB; it does not discover or merge multiple stores.
- **Project rename / move handling** — if a repo is moved on disk, its tasks keep the old `project_root` string. No reconciliation in v1.
- **Renaming or aliasing the display name** — display name is derived from the path; no user-editable project labels.
- **Per-project filtering UI** — grouping only in this slice.
- **Cross-machine sync** — the store is local; nothing syncs `~/.trace/` across machines.

## Open Questions

None.
