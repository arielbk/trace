# Trace QA Plan

## Already verified by the agent (post-addendum slices)

- [x] Drizzle + `better-sqlite3` storage swap: `pnpm --filter @trace/core test` (incl. the new WAL/migration test), `pnpm -r check-types`. Schema lives in `packages/core/src/schema.ts`; generated migration in `packages/core/drizzle/`.
- [x] vitest migration: `pnpm -r test` runs every previously-existing test under vitest (12 tests across `@trace/core`, `@trace/cli`, `web`); repo grep for `node:test` and `node --test` returns no matches in source or scripts.
- [x] Vite + React web app: `pnpm --filter web build` produces a Vite production SPA in `apps/web/dist/`; `pnpm --filter web test` passes the data-adapter parity test; no `next` references remain in `apps/web` or root.
- [x] ccusage evaluation: rejected with documented ADR-style rationale in `trace.log.md` — ccusage ships only as a CLI binary with no programmatic exports.

## Already verified by the agent

- [x] Monorepo task CRUD: CLI create/show/list persistence and core store round-trip tests passed.
- [x] Monorepo task CRUD: core and CLI TypeScript typechecks passed.
- [x] Session register/assign: core lifecycle and one-session-one-task invariant tests passed.
- [x] Session register/assign: CLI register -> assign -> show/list smoke coverage passed.
- [x] Claude Code adapter: transcript fixture parsing and SessionStart hook registration smoke coverage passed.
- [x] Claude Code adapter: core/CLI tests and typechecks passed.
- [x] Codex adapter: rollout JSONL identity validation, token parsing, and scan backfill tests passed.
- [x] Codex adapter: CLI scan smoke coverage against a temporary Codex home fixture passed.
- [x] Codex adapter: existing core/CLI tests and typechecks passed.
- [x] Doc association: core add/list/remove tests and CLI add-doc -> show integration coverage passed.
- [x] Doc association: core/CLI typechecks passed.
- [x] Timeline rollup: core mixed-session/doc/token rollup tests and CLI timeline JSON shape coverage passed.
- [x] Skill wrapper: scripted bind and re-entry CLI smoke coverage passed.
- [x] Skill wrapper: all core/CLI node tests, core and CLI typechecks, and Prettier checks for touched files passed.
- [x] Web view: seeded SQLite web data adapter test matched the core timeline output.
- [x] Web view: Next typecheck, lint, and production build passed.

## Human verification required

### Setup

The CLI and the web app must point at the **same** SQLite store. The web app defaults to `.trace/trace.sqlite` relative to its own process, so pin both to one absolute path via `TRACE_DB`. Run all commands below from the repo root (`/Users/arielbk/Projects/side/trace-v2`).

```bash
# 1. One shared DB path, exported for every command in this session.
export TRACE_DB="$PWD/.trace/qa.sqlite"

# 2. Seed a task + session + doc via the CLI (run with no args to see full usage).
node apps/cli/src/trace.ts                                   # prints the usage line
node apps/cli/src/trace.ts task create "QA smoke task"       # note the task id it prints back
node apps/cli/src/trace.ts session register --id qa-sess-1 --tool claude --input-tokens 1200 --output-tokens 800
node apps/cli/src/trace.ts session assign qa-sess-1 <task-id>
node apps/cli/src/trace.ts task add-doc <task-id> docs/trace/trace.prd.md
node apps/cli/src/trace.ts task timeline <task-id> --json     # the JSON you'll compare the web view against

# 3. Start the web app (same TRACE_DB env).
cd apps/web && pnpm dev      # serves on http://localhost:3000
```

(If a flag above doesn't match, the no-arg usage line and `apps/cli/src/trace.ts` are the source of truth — the loop ran in a sandbox, so syntax here is from the code, not a live run.)

- [ ] **`/` lists tasks from the shared store**
  - Open: `http://localhost:3000/`
  - Expect: the "QA smoke task" you created above appears in the list. Create a second task via the CLI, refresh, and confirm it shows up (routes render dynamically per request).
- [ ] **Task detail matches the CLI timeline**
  - Open: `http://localhost:3000/task/<task-id>` (the id from setup)
  - Expect: the assigned session, the added doc, and token totals match the `task timeline --json` output from step 2 — same items, same order, same summed tokens.
- [ ] **Claude Code SessionStart hook registers a session**
  - The hook script is `apps/cli/src/claude-session-start-hook.ts`; it reads Claude hook JSON on stdin and registers an unassigned `claude` session.
  - Wire it as a `SessionStart` hook in a real Claude Code settings file (point the command at `node /abs/path/apps/cli/src/claude-session-start-hook.ts`), then start a Claude Code session.
  - Quick stdin smoke without Claude: `echo '{"hook_event_name":"SessionStart","session_id":"hook-test-1","transcript_path":"/tmp/x.jsonl"}' | node apps/cli/src/claude-session-start-hook.ts`
  - Expect: `node apps/cli/src/trace.ts session list --unassigned` then shows the new session id.
- [ ] **Codex in-session bind / scan backfill**
  - Run: `node apps/cli/src/trace.ts session scan --codex --codex-home <path-to-a-real-or-fixture-codex-home>`
  - For the live in-session path, set `CODEX_THREAD_ID` to the active Codex thread before binding.
  - Expect: discovered Codex sessions appear as unassigned `codex` sessions in `session list --unassigned`, with token totals populated.
- [ ] **Trace skill wrapper in an agent session**
  - Run: `node apps/cli/src/trace.ts skill work-on-task <task-id>` inside (or simulating) an agent session — it infers the session id from `CODEX_THREAD_ID` or Claude session env vars, or accepts explicit `--id`/`--transcript`/`--tool`.
  - Then: `node apps/cli/src/trace.ts skill re-enter <task-id>`
  - Expect: `work-on-task` registers+assigns the current session to the task; `re-enter` emits the task's docs and prior-session references as context.

## Watch closely

- [ ] Storage uses Node 24's built-in `node:sqlite` instead of Drizzle plus `better-sqlite3` because network access was unavailable during implementation.
- [ ] Session register/assign followed the existing Node SQLite store boundary rather than introducing the originally named database libraries.
- [ ] Codex adapter initially exposed token totals at the adapter layer before persistence landed in the timeline slice; confirm current scans still persist token totals end to end.
- [ ] Timeline token columns are added through lightweight `ALTER TABLE` migration defaults for existing databases.
- [ ] Skill wrapper CI coverage uses explicit simulated session flags and env inference, not live Claude Code or Codex sessions.
- [ ] Web route smoke could not bind a local HTTP listener in the sandbox due to `EPERM`; browser-level route verification remains manual.
