# Tasks: session-registration-gap

Vertical slices forming a DAG. Each slice is red→green→refactor with its own feedback loop.

## Diagnosis (no code; informs the slices)

Reading the code (live Claude sessions can't be launched in this sandbox, so this is a static diagnosis):

1. **`compact` source is unmatched.** `hooks/hooks.json` declares the SessionStart matcher as `"startup|resume|clear"`. The Claude Code SessionStart matrix also includes `compact`. A compact-sourced start never fires the hook, so its session is never registered. `clear` *is* matched, so the PRD's prime suspect would fire — but if registration then fails silently, the result is the same observed gap.
2. **Silent failure.** `runClaudeSessionStartHook` returns a non-zero exit + stderr on failure (bad store path, register throw), but Claude Code does not surface SessionStart hook stderr/exit to the user. Any failure is invisible: no log, no trace. The 2026-06-03 gap is indistinguishable from "hook fired and errored".
3. **No Claude backfill.** `trace session scan` only supports `--codex`. There is no path to recover Claude transcripts that exist on disk (`~/.claude/projects/...` or `~/.claude-infinum/projects/...`) but are missing from the store. The two config homes mean the scan must accept an explicit projects root.

## Slices

### S1 — Match every SessionStart source (matcher fix) [no deps]
- **Change:** `hooks/hooks.json` matcher → include `compact` (full matrix `startup|resume|clear|compact`). Make the hook itself source-agnostic: it already ignores `source`, so add a passing test per source value (`startup`, `resume`, `clear`, `compact`) proving registration succeeds regardless of `source` in the stdin payload.
- **Feedback:** `pnpm --filter @trace/cli test`.
- **Outside-in:** SessionStart payload `{ session_id, transcript_path, source, hook_event_name }` → store row exists for each source.

### S2 — Observable hook failures (append-only log) [no deps]
- **Change:** When the hook's registration fails (non-zero from `runTraceCli`, or a thrown error), append a structured line to a log file under the trace data dir (e.g. `~/.trace/hook-errors.log`, sibling of the db; honor `TRACE_DB` dir). Never throw out of logging. Keep returning the existing exit code/stderr too.
- **Feedback:** `pnpm --filter @trace/cli test` — assert a forced failure (e.g. unwritable/invalid db path surrogate, or a register that throws) writes a log line; success writes nothing.
- **Outside-in:** failing hook invocation → log file contains a timestamped entry naming the session id + reason.

### S3 — Core: scan Claude transcripts from a projects root [no deps]
- **Change:** Add `scanClaudeCodeSessions(projectsRoot)` to `claude-code-adapter.ts` mirroring `scanCodexSessions`: walk `<projectsRoot>` for `*.jsonl`, parse each via `parseClaudeCodeTranscriptFile`, skip unparseable files (transcripts with no session id), return `ParsedClaudeCodeSession[]`. Export from `index.ts`.
- **Feedback:** `pnpm --filter @trace/core test`.
- **Outside-in:** a dir with two valid claude jsonl files + one garbage file → two parsed sessions.

### S4 — CLI: `trace session scan --claude` backfill [deps: S3]
- **Change:** Extend `trace session scan` to accept `--claude` with `--projects-root <path>` (default `~/.claude/projects` when HOME set). Register each scanned session through the same `store.registerSession` path the codex scan uses (shared registration; can't drift). Document the `~/.claude` vs `~/.claude-infinum` distinction in the runbook (operator passes `--projects-root`).
- **Feedback:** `pnpm --filter @trace/cli test`.
- **Outside-in:** `trace session scan --claude --projects-root <dir>` → `trace session list --unassigned` shows the on-disk-but-unregistered sessions.

### S5 — Regression test for the diagnosed failure mode [deps: S1, S2]
- **Change:** A focused regression test pinning the specific gap: a `compact`/`clear`-sourced SessionStart that previously would not have registered now does; and a hook failure leaves an observable log line rather than silence.
- **Feedback:** `pnpm --filter @trace/cli test`.

### S6 — Rebuild bundled bin/dist artifacts [deps: S1–S5]
- **Change:** `node apps/cli/src/build.ts` to regenerate `bin/*.js` and `apps/cli/dist/*.js` so the shipped plugin hook matches source. Verify bundle test.
- **Feedback:** `pnpm --filter @trace/cli test:bundle`, `pnpm --filter @trace/cli check-types`, `pnpm --filter @trace/core check-types`, lint.

## DAG

```
S1 ─┐
S2 ─┼─> S5 ─> S6
S3 ─> S4 ──────┘
```
