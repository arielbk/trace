# Usable v1 Implementation Log

## `model-capture` — 2026-05-29 01:57:12 CEST

**Status:** done
**Summary:** Added nullable session model capture end-to-end. `registerSession` now accepts and persists `model`, timeline session items include `model`, `trace session register --model ...` round-trips through `trace task timeline <id> --json`, and Claude Code/Codex transcript adapters infer model metadata from their fixtures while returning `null` when absent.
**Deviations:** The Drizzle migration was written manually as `0002_session_model.sql` because the existing migration history in this repo already includes manually maintained snapshots.
**Handoff:** Verified with focused adapter/store/CLI tests, full `@trace/core` and `@trace/cli` test suites, and core/CLI typechecks. Existing databases migrate by appending nullable `sessions.model`, so old rows remain readable and surface `model: null`.
