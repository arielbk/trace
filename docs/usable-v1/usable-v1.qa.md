# QA Plan: Usable v1

## What was built

The last-mile changes that make Trace usable day-to-day: the model is captured
end-to-end (schema + adapters + store + CLI + web), the `trace` CLI is reachable
from any directory via `pnpm link --global`, an in-repo Claude Code skill drives
the CLI from natural language ("we're working on X" / "re-enter X"), and the
read-only web timeline renders color-coded tool tags, model chips, and baseline
page styling.

Implemented by a Codex Ralph run (5 iterations, all slices settled). Both human
checkpoints (`repo-skill`, `web-color`) were then verified live by the agent —
see "Human verification run" below.

## Already verified by the agent

These were run during implementation and/or verification and passed.

- [x] `pnpm -r test` — full suite green: core 17, web 5, cli 17 (39 tests)
- [x] `pnpm -r check-types` — clean across core, ui, web, cli, docs
- [x] `pnpm --filter @trace/cli test` — 17/17 (incl. adapter model fixtures, store round-trip, CLI `--model`)
- [x] `trace task list` from outside the repo (`/tmp`, HOME-only) returns the global-store tasks — **after the `cli-link` fix below**
- [x] repo-skill round-trip through the **real linked `trace`**: `work-on-task` created + bound a session; `re-enter` surfaced task + docs + session refs
- [x] `skill work-on-task --model` persists the model end-to-end (new test + live check)
- [x] web API `/api/tasks/:id/timeline` returns `session.model` for claude/codex sessions and `null` when absent
- [x] Production build: `pnpm --filter @trace/web build` clean (run by the implementing iteration)

## Human verification run (completed by the agent)

Both `Human checkpoint: yes` slices were exercised live rather than left for a
human. Artifacts in [`qa-artifacts/`](./qa-artifacts/).

- [x] **`repo-skill` — natural-language path drives the CLI**
  - Linked the CLI: `pnpm link --global` (exposes `trace` at `~/Library/pnpm/bin/trace`).
  - `node .claude/skills/trace/trace-skill.mjs work-on-task "usable-v1 verification" --id uv1-bind-demo --transcript /tmp/uv1-bind-demo.jsonl --tool claude` → created the task and bound the session (`rc=0`, prints `uv1-bind-demo\tclaude\t…`).
  - `node .claude/skills/trace/trace-skill.mjs re-enter "usable-v1 verification"` → printed `task:`, `title:`, `docs:`, and `sessions:` (all four bound sessions).
  - `--model` forwarded through the helper persists on the session (`uv1-skill-model` → `gpt-5.1-codex-max`).
  - **Result: PASS.**
- [x] **`web-color` — running app reads as intentional**
  - Started `cd apps/web && env -u TRACE_DB pnpm dev` (http://localhost:3000/).
  - Seeded one task with a claude session (model `claude-opus-4-7`), a codex session (model `gpt-5.1-codex-max`), and two null-model sessions, plus a doc.
  - Recorded the flow with `agent-browser`: home → task detail.
  - **Result: PASS.** Tool tags are color-coded and distinct (claude rust `#b94700`, codex teal `#1f6f5b`, doc slate `#475467`); model chips show `claude-opus-4-7` / `gpt-5.1-codex-max` and `—` for nulls; header + token cards (7000/2100/2500) + row separators read as intentional, not raw HTML.
  - Artifacts: `usable-v1-web.webm` (4.7s recording, verified non-empty via `ffprobe`), `usable-v1-web.png` (full-page screenshot).

## Watch closely

- **`cli-link` was a false green — found and fixed during verification.**
  `trace.ts` guarded execution with `import.meta.url === \`file://${process.argv[1]}\``.
  Through a `pnpm link` symlink, `argv[1]` is the symlink path while `import.meta.url`
  is the realpath, so they never matched — the CLI exited 0 with **zero output**.
  The original `cli-link` test only ran the real path against an empty HOME and
  asserted `=== ""`, so it passed whether or not the CLI worked. **Fix:** compare
  resolved realpaths (`realpathSync(argv[1]) === fileURLToPath(import.meta.url)`);
  rewrote the test to seed a task and invoke through a symlink, asserting the task
  lists. (commit `fix(cli-link): …`)
- **`skill work-on-task --model` was missing — found and fixed.** The PRD's
  implementation/testing decisions specify `--model` on `skill work-on-task`, but
  the parser rejected it (`Unknown option: --model`). `model-capture`'s own
  feedback loop only required it on `session register`, so it slipped through.
  Added the flag + a CLI test.
- **Stale Vite cache, not a code defect.** On first load the model chip rendered
  `—` for every session. Root cause was a stale on-disk `apps/web/node_modules/.vite`
  SSR cache from a prior dev session (pre-`model-capture`). A clean restart
  (`rm -rf apps/web/node_modules/.vite` + `pnpm dev`) surfaced the models correctly.
  `@trace/core` returns `model` correctly when imported directly. No code change
  needed, but worth a `--force` / cache clear if a stale chip ever reappears.
- `model-capture` deviation (from log): the Drizzle migration `0002_session_model.sql`
  was hand-written to match the repo's existing manually-maintained migration history.

## Notes / cleanup

- The verification task `usable-v1 verification` and its `uv1-*` demo sessions
  persist in `~/.trace/trace.sqlite`. There's no `task delete` CLI; to reset, run
  `/usr/bin/sqlite3 ~/.trace/trace.sqlite "DELETE FROM sessions WHERE id LIKE 'uv1-%';"`
  and delete the task row, or remove `~/.trace/trace.sqlite*` to start fresh.
- `~/.trace/credentials.json` is unrelated/pre-existing — do not delete.

## Open questions

None.
