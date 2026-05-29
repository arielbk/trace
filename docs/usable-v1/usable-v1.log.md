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
