# Usable v1 Implementation Log

## `model-capture` — 2026-05-29 01:57:12 CEST

**Status:** done
**Summary:** Added nullable session model capture end-to-end. `registerSession` now accepts and persists `model`, timeline session items include `model`, `trace session register --model ...` round-trips through `trace task timeline <id> --json`, and Claude Code/Codex transcript adapters infer model metadata from their fixtures while returning `null` when absent.
**Deviations:** The Drizzle migration was written manually as `0002_session_model.sql` because the existing migration history in this repo already includes manually maintained snapshots.
**Handoff:** Verified with focused adapter/store/CLI tests, full `@trace/core` and `@trace/cli` test suites, and core/CLI typechecks. Existing databases migrate by appending nullable `sessions.model`, so old rows remain readable and surface `model: null`.

## `cli-link` — 2026-05-29 02:01:52

**Status:** done
**Summary:** Exposed a root-level `trace` bin that points to the existing TypeScript CLI entry at `apps/cli/src/trace.ts`, made that entry executable for package-manager link shims, and documented `pnpm link --global` in `docs/usable-v1/cli-link.md` for the repo skill to reference.
**Deviations:** `pnpm link --global` prints a pnpm warning about no binaries while still creating the `trace` shim in the configured global bin dir; the linked command was verified from an external directory.
**Handoff:** Verified with a red/green CLI link test, the full `@trace/cli` vitest suite, `@trace/cli` typecheck, and a temp-global manual link smoke test where `trace task list` exited 0 outside the repo.

## `repo-skill` — 2026-05-29 02:05:17 CEST

**Status:** needs-review
**Summary:** Added an in-repo Claude Code Trace skill at `.claude/skills/trace/SKILL.md` plus a helper script that dispatches `work-on-task` and `re-enter` by exact task title. `work-on-task` resolves or creates the task, then delegates to `trace skill work-on-task` with live or simulated session flags; `re-enter` resolves an existing task and delegates to `trace skill re-enter`.
**Deviations:** The automated helper supports explicit session flags and `TRACE_BIN` for tests, while the live natural-language Claude Code path remains the slice's required human checkpoint.
**Handoff:** Verified with a red/green repo skill smoke test through the real Trace CLI using a simulated Claude session, the full `@trace/cli` vitest suite, and `@trace/cli` typecheck. Human review should exercise the skill phrasing in a live Claude Code session after `pnpm link --global` exposes `trace`.

## `web-color` — 2026-05-29 02:09:56 CEST

**Status:** needs-review
**Summary:** Added a reusable `TaskTimelineView` for the web task page with baseline page styling, token summary cards, subtle timeline row separation, colored tool tags for Claude/Codex sessions, a doc tag, and muted model chips that render the model name or `—` when absent. Extended the web data-layer test to seed a model and assert the surfaced timeline includes it.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape. The slice has a required visual human checkpoint, so it is settled as `needs-review` after automated verification.
**Handoff:** Verified with the red/green `TaskTimelineView` server-render test, the focused web data-layer test, full `@trace/web` vitest suite, `@trace/web` typecheck, and `@trace/web` production build. Human review should run the web app against a task timeline containing Claude and Codex sessions and eyeball the tag colors, model chip, spacing, and row separation.
