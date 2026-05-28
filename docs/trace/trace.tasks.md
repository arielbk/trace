# Trace

A local, read-only tool that registers Claude Code and Codex sessions, lets each be assigned to exactly one task, and rolls a task's sessions + docs + tokens into one timeline — surfaced through a self-verifiable CLI and a zero-design read-only web view. Turborepo: `packages/core` holds the logic; `apps/cli` and `apps/web` consume it. Storage is SQLite (WAL mode) via Drizzle + `better-sqlite3`, behind a swappable store interface in `core`.

## Slices

### `monorepo-task-crud` — Monorepo skeleton + task CRUD

**Status:** done

**Outside-in:** `trace task create "checkout"` prints a task ID; `trace task show <id>` prints the task; `trace task list` lists it. Data persists in a SQLite file across invocations.

**Feedback loop:** CLI integration test: `create` → `show` round-trips the task. Core unit test: task entity persists and reads back via the store interface. Locks SQLite (WAL) + Drizzle + `better-sqlite3` and the Turborepo wiring (`core` consumed by `cli`).

**Human checkpoint:** no

**Depends on:** none

### `session-register-assign` — Session register + assign

**Status:** done

**Outside-in:** `trace session register --id <id> --transcript <path> --tool <claude|codex>` creates an unassigned session; `trace session assign <id> <task>` binds it; `trace session list --unassigned` shows the pile; assigned sessions appear under `trace task show <task>`.

**Feedback loop:** Core unit tests assert the **one session = one task** invariant (re-assigning moves, never duplicates; a session cannot belong to two tasks) and the unassigned→assigned lifecycle. CLI integration test: register → assign → show.

**Human checkpoint:** no

**Depends on:** monorepo-task-crud

### `claude-code-adapter` — Claude Code adapter + SessionStart hook

**Status:** done

**Outside-in:** A `SessionStart` hook runs `trace session register` so a live Claude Code session lands in the unassigned pile the moment it starts; the adapter parses a transcript for token totals.

**Feedback loop:** Adapter unit test over a recorded Claude Code JSONL fixture asserts the produced session record (ID, transcript path) and token totals. Smoke test: invoke the hook script against a fixture and assert a session row is created via the CLI.

**Human checkpoint:** no

**Depends on:** session-register-assign

### `codex-adapter` — Codex adapter (in-session bind + scan backfill)

**Status:** done

**Outside-in:** A Codex-side step runs `trace session register --id $CODEX_THREAD_ID` to bind in-session; `trace session scan --codex` backfills from `~/.codex/sessions/` + `session_index.jsonl` for sessions never bound live. Tokens come from the `turn.completed` usage field.

**Feedback loop:** Adapter unit test over captured Codex rollout JSONL + a `--json` event-stream fixture asserts `thread.started` ID == rollout filename ID == `$CODEX_THREAD_ID`, plus parsed token usage. Smoke test: run `scan --codex` against a fixtures dir and assert backfilled session rows.

**Human checkpoint:** no

**Depends on:** session-register-assign

### `doc-association` — Task-scoped doc association

**Status:** done

**Outside-in:** `trace task add-doc <task> <path>` associates a spec/plan with a task; `trace task show <task>` lists associated docs.

**Feedback loop:** Core unit test: doc associates to a task and reads back; removing an association works. CLI integration test: `add-doc` → `show` lists it.

**Human checkpoint:** no

**Depends on:** monorepo-task-crud

### `timeline-rollup` — Task timeline rollup

**Status:** done

**Outside-in:** `trace task timeline <id> --json` returns one ordered timeline aggregating the task's sessions (both tools), associated docs, token totals, and timestamps.

**Feedback loop:** Core unit test over a task with mixed-tool sessions + docs + token data asserts the aggregated, correctly-ordered result; covers the empty-task and unassigned-pile cases. CLI integration test on `task timeline --json` shape.

**Human checkpoint:** no

**Depends on:** session-register-assign, doc-association

### `skill-wrapper` — Agent skills over the CLI

**Status:** done

**Outside-in:** A "work on task X" skill creates/binds the current session (Claude Code session ID or `$CODEX_THREAD_ID`) via the CLI; a "re-enter task X" skill emits the task's associated docs + prior-session references as context. Lightweight re-entry only — no auto-continue.

**Feedback loop:** Smoke test: a scripted round-trip drives the bind path through the CLI (simulated session ID) and asserts the session is bound, then asserts re-entry output lists the expected docs + session refs. No live-session dependency in CI.

**Human checkpoint:** no

**Depends on:** claude-code-adapter, codex-adapter, timeline-rollup

### `web-view` — Read-only web timeline

**Status:** done

**Outside-in:** Local web app over the same `core` store: `/` lists tasks; `/task/:id` shows the task timeline (sessions, docs, tokens). Read-only — no editing, auth, or filtering. Zero design budget.

**Feedback loop:** Headless smoke test: load `/` and assert the seeded task renders; load `/task/:id` and assert its sessions + docs appear, matching `trace task timeline --json`.

**Human checkpoint:** no

**Depends on:** timeline-rollup

### `drizzle-storage` — Swap `node:sqlite` for Drizzle + `better-sqlite3`

**Status:** done

**Outside-in:** The store in `packages/core` is backed by `better-sqlite3` (WAL mode) with Drizzle schemas/migrations, behind the existing swappable store interface. Public store API (task/session/doc/timeline) is unchanged; consumers (CLI, web, hooks) work identically. The interim `node:sqlite` implementation is removed.

**Feedback loop:** All existing core/CLI tests still pass against the Drizzle-backed store unchanged. A new core unit test asserts the store opens in WAL mode (`journal_mode=wal`) and that Drizzle migrations apply cleanly to a fresh DB and are a no-op on an existing DB. `pnpm -r typecheck` and `pnpm -r test` pass.

**Human checkpoint:** no

**Depends on:** monorepo-task-crud, session-register-assign, doc-association, timeline-rollup

### `vitest-migration` — Move tests from `node --test` to vitest

**Status:** not-started

**Outside-in:** All test files in `packages/core`, `apps/cli`, and `apps/web` run under `vitest` (the addendum-mandated runner). Each package exposes a `test` script that invokes `vitest run`; `pnpm -r test` runs the full suite green. `node --test` is no longer referenced by any script or doc.

**Feedback loop:** `pnpm -r test` runs every previously-existing test under vitest and they all pass. Tests are converted, not deleted — `node:test`/`node:assert` imports become `vitest` (`describe`/`it`/`expect`). Repo grep for `node:test` and `node --test` returns nothing in source or scripts.

**Human checkpoint:** no

**Depends on:** monorepo-task-crud, session-register-assign, claude-code-adapter, codex-adapter, doc-association, timeline-rollup, skill-wrapper, web-view

### `vite-web` — Replace Next.js web app with Vite + React

**Status:** not-started

**Outside-in:** `apps/web` is a **Vite + React** app (per PRD addendum) — not Next.js. `/` lists tasks; `/task/:id` shows the timeline. Reads the same `packages/core` store via a thin server-side data layer (e.g. a tiny `vite-plugin`-served endpoint or a small companion process) since the browser can't open SQLite directly. Read-only. Zero design budget. The Next.js app is deleted.

**Feedback loop:** `pnpm --filter web build` produces a Vite production build. A headless adapter test (mirroring the existing web data adapter test) seeds the SQLite store and asserts the Vite app's data layer matches the core timeline output. No `next` dependency or config remains in `apps/web` or root.

**Human checkpoint:** no

**Depends on:** web-view

### `ccusage-tokens` — Evaluate `ccusage` for Claude Code token extraction

**Status:** not-started

**Outside-in:** The Claude Code adapter uses `ccusage` (the Claude Code token-usage reader pmdr already depends on) for token totals where it can, falling back to the current hand-parsed JSONL only for fields `ccusage` does not cover. The decision (adopt / partial / reject) is recorded as a short ADR-style note appended to `trace.log.md` with the rationale.

**Feedback loop:** Adapter unit tests over the existing Claude Code JSONL fixture still pass and assert the same token totals as before. If `ccusage` is adopted, the adapter imports it and the test demonstrates parity with the prior hand-parsed result; if rejected, the log entry explains why with concrete evidence (missing field, API shape mismatch, etc.).

**Human checkpoint:** no

**Depends on:** claude-code-adapter
