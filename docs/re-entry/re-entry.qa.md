# QA Plan: Handoff Re-entry

## What was built

Re-entry: from a fresh agent, "re-enter task X" picks up the thread with zero
re-explaining — fed by decision-docs (primary) and a transcript tail (fallback).

- **`doc-store`** — task docs live at `~/.trace/tasks/<taskId>/docs/`; writing a
  file there associates it with the task (no registration). `listDocsForTask`
  returns the union of trace-native files + external `add-doc` paths, deduped.
- **`transcript-tail`** — `trace session tail <id> [--limit N]` prints the last N
  human/assistant messages as clean text, abstracting over Claude vs Codex JSONL.
- **`re-entry-payload`** — `trace skill re-enter X` returns an ordered manifest
  (task header, decision-docs, session pointers newest-first, most-recent flagged);
  pointers only, empty sections degrade gracefully.
- **`re-entry-skill`** — the `trace` skill's consumption protocol (docs first,
  transcript tail only if needed, never paste raw transcripts) + `work-on-task`
  reports `taskDocsDir`. Codex entry point left as an explicit deferred seam.
- **`setup-path`** — `trace init` writes an idempotent Claude `SessionStart` hook,
  confirms the skill is discoverable, prints the manual `pnpm link --global` note.
- **`readme-walkthrough`** — first-user README with the verified same-tool hero loop.

Implemented by a **Codex Ralph run** that completed 4 slices, then exhausted its
usage limit. **Claude (the orchestrator) took over** `readme-walkthrough`, fixed
a cross-cutting env-var bug, and ran the human verification below — per the run
instruction to step in when Codex can't continue.

## Already verified by the agent

Run during implementation/verification and passing.

- [x] `pnpm --filter @trace/core test` — 25/25
- [x] `pnpm --filter @trace/cli test` — 24/24
- [x] `pnpm --filter @trace/core check-types` and `@trace/cli check-types` — clean
- [x] Prettier clean on all touched TS/Markdown
- [x] `doc-store`: native-doc dir + union/dedup + missing-dir (no throw) — red/green core + CLI acceptance
- [x] `transcript-tail`: last-N over both Claude and Codex fixtures; malformed/empty/missing → empty
- [x] `re-entry-payload`: manifest with both doc sources, newest-first sessions, most-recent flag, empty sections
- [x] `trace init` output + idempotency verified against a temp settings path (second run is a no-op, no duplicate hook)
- [x] **env-var fix** (`CLAUDE_CODE_SESSION_ID`) red→green CLI test: `work-on-task` binds the live session with no `--id`

## Human verification run (completed by the agent)

The same-tool hero loop — the feature's whole point — was exercised live with the
**linked `trace` CLI** through the skill helper, with `CLAUDE_CODE_SESSION_ID` set
and no `--id` (i.e. exactly the live-session path):

- [x] **Hero loop (same-tool, docs-first)**
  - `work-on-task "Checkout flow"` → created the task, auto-inferred + bound the
    live session, printed `taskDocsDir: …/tasks/<id>/docs`.
  - Wrote `decisions.md` into that dir (no registration call).
  - `/clear` simulated → `re-enter "Checkout flow"` → manifest surfaced the task
    header, `docs:` containing `decisions.md`, and the session under `sessions:`
    flagged `mostRecent: true`.
  - **Result: PASS.**

## Watch closely

- **`work-on-task` auto-inference was a real bug — found and fixed during takeover.**
  `inferCurrentSessionId` read `env.CLAUDE_SESSION_ID ?? env.session_id`, but live
  Claude Code exports **`CLAUDE_CODE_SESSION_ID`**. So from inside a real session
  the skill always failed with "requires --id or a current session env var" — the
  exact flow `re-entry-skill` and the README depend on. The `re-entry-skill` slice
  shipped `needs-review` without catching this because its tests passed `--id`
  explicitly. **Fix:** prefer `CLAUDE_CODE_SESSION_ID` (legacy names still accepted
  for hook-stdin callers), updated `SKILL.md` prose, added a no-`--id` CLI test.
  (commit `8ec8164`)
- **CLI verbs take a task _id_; the helper resolves _titles_.** `trace skill
work-on-task <id>` / `re-enter <id>` operate on task ids and do not create tasks;
  the resolve-or-create-by-title logic lives in `trace-skill.mjs`. Drive the skill
  through the `.mjs` helper (as the README and `SKILL.md` do), not the raw CLI verb.
- **Codex ran out of credits mid-run.** Iterations 6–30 all failed with
  `invalid_grant` / "You've hit your usage limit"; the loop spun to the cap and
  exited 75. No partial/orphaned work — `setup-path` had already committed cleanly
  before the wall. Re-running the Codex path later requires `codex login` / quota.

## Still needs a human (acceptance gate)

The README's stated acceptance gate is a **clean-checkout, real-session** run by
the repo owner. The agent verified the mechanics with the linked CLI, but not a
pristine end-to-end. To close it:

- [ ] On a clean checkout: `pnpm install` → `pnpm link --global` → `trace init`.
- [ ] Start a **real** Claude Code session; confirm `trace session list --unassigned`
      shows it (proves the `SessionStart` hook fired — not yet exercised live, only
      unit-tested + temp-path verified).
- [ ] In that session: "we're working on X", write a decision doc into the reported
      `taskDocsDir`, `/clear`, then "re-enter X" in a fresh session and confirm the
      agent picks up the thread with **no re-explaining**.
- [ ] Skim `.claude/skills/trace/SKILL.md` prose for the consumption protocol.

## Notes / cleanup

- The agent earlier bound this live orchestration session to a real task
  **`Handoff Re-entry`** (`313ee22a`) in `~/.trace/trace.sqlite` while dogfooding.
  The hero-loop verification used throwaway temp `TRACE_DB`s (cleaned up).
- No `task delete` CLI exists; to reset, edit/remove `~/.trace/trace.sqlite*`.

## Open questions

None — but note the deferred **cross-tool (Codex) re-entry** is explicitly out of
scope here (architecture is tool-agnostic; the Codex session hook + skill wrapper
is the next increment, as stated in the README).
