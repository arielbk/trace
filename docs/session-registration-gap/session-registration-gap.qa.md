# QA plan: session-registration-gap

Checked items were run during implementation. Unchecked items require a live
Claude Code instance (not available in the build sandbox) and are written as
self-contained runbooks.

## Automated (verified)

- [x] `pnpm --filter @trace/core test` — 60 passing, incl. `scanClaudeCodeSessions` (parses a projects root, skips id-less/garbage files, empty for a missing root).
- [x] `pnpm --filter @trace/cli test` — 42 passing, incl. source-coverage (`startup|resume|clear|compact`), hook-error-log (writes on failure, silent on success), `scan --claude` backfill, and the clear-sourced regression test.
- [x] `pnpm --filter @trace/core check-types` and `pnpm --filter @trace/cli check-types` — clean.
- [x] `pnpm --filter @trace/core lint` and `pnpm --filter @trace/cli lint` — clean (max-warnings 0).
- [x] `node apps/cli/src/build.ts` — bundles regenerated; `bin/*.js` + `apps/cli/dist/*.js` updated and pass the bundle smoke test under vitest.
- [x] `hooks/hooks.json` SessionStart matcher is `startup|resume|clear|compact` (asserted in `plugin-scaffold.test.ts`).

## Manual (human-only — needs a live Claude Code session)

- [ ] **`/clear` registers a session.** In a real project with the trace plugin installed: start a Claude session, run `/clear`, then `trace session list --unassigned`. Confirm the post-clear session id appears. (Repro of the 2026-06-03 gap.)
  - Runbook: `cd <project>`; launch Claude; note the session id from the status line; `/clear`; in another shell `trace session list --unassigned | grep <new-session-id>`.
- [ ] **`compact` registers a session.** Trigger an auto- or manual `/compact` so Claude emits SessionStart with `source: compact`; confirm a new store row appears via `trace session list --unassigned`. This is the matcher gap the fix closes.
- [ ] **Resume and fresh startup still register.** `claude --resume` an existing session and a fresh `claude` launch; confirm both produce store rows. (Guards against the matcher widening breaking the already-working paths.)
- [ ] **Hook failures are observable.** Temporarily point the hook at an unwritable db (e.g. set `TRACE_DB=/dev/null/x` in the plugin env) and start a session; confirm `<db-dir>/hook-errors.log` gains a timestamped line naming the session id, and that the session is otherwise non-fatal to Claude startup. Restore `TRACE_DB`.
- [ ] **Backfill recovers a real on-disk gap.** Find a transcript under `~/.claude-infinum/projects/<encoded-project>/<id>.jsonl` (or `~/.claude/projects/...`) with no matching store row, then run `trace session scan --claude --projects-root ~/.claude-infinum/projects`. Confirm `trace session list --unassigned` now lists it and that re-running scan is idempotent (no duplicate row, registration de-dupes on id).
- [ ] **Config-home selection.** Confirm which config home (`~/.claude` vs `~/.claude-infinum`) the installed Claude Code actually writes transcripts to, and document it so operators know which `--projects-root` to scan. (Open question from the PRD — the scan defaults to `~/.claude/projects` but accepts an explicit root.)
