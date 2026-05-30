# Core Deepening

Behavior-preserving refactors that turn shallow, scattered modules in `@trace/core` and the CLI into deep ones — concentrating per-tool transcript knowledge, token-total math, session identity, and the dual-source doc contract each in one named place. Goal: testability and AI-navigability, no change to observable behavior.

## Slices

### `token-totals` — Deep TokenTotals value module

**Status:** done

**Outside-in:** `@trace/core` exports a `TokenTotals` module with `empty()`, `add(a, b)`, and `fromUsage(raw)`; both transcript adapters and the store consume it instead of their own copies.

**Feedback loop:** New unit tests on `empty`/`add`/`fromUsage` (incl. the `total ?? sum-of-parts` derivation and snake_case/camelCase usage keys); existing `claude-code-adapter`, `codex-adapter`, and `task-store` tests stay green.

**Human checkpoint:** no

**Depends on:** none

### `transcript-adapters` — One deep adapter per tool

**Status:** done

**Outside-in:** A single transcript-adapter interface per `SessionTool` (claude, codex) answering id, model, token totals, and message tail from a transcript; callers (store, CLI, hook) consult an adapter rather than importing three free functions and re-branching on the tool string.

**Feedback loop:** One adapter test surface per tool exercises parse + tail against the shared fixture (`fixtures/claude-code-session.jsonl`, `fixtures/codex-thread-1.jsonl`); existing `transcript-tail` and adapter tests stay green; CLI `session tail` / `session scan --codex` behavior unchanged.

**Human checkpoint:** no

**Depends on:** token-totals

### `session-identity` — Lift env→Session inference into core

**Status:** done

**Outside-in:** A core module owning the cross-tool "which env var is the live session" contract (replacing `inferCurrentTool` / `inferCurrentSessionId` / `inferTranscriptPath` in the CLI), takes an env map and returns tool + id + transcript path.

**Feedback loop:** New unit tests driving the module with env maps (Codex `CODEX_THREAD_ID`, Claude `CLAUDE_CODE_SESSION_ID` + legacy fallbacks, transcript-path synthesis); existing `skill work-on-task` CLI tests stay green.

**Human checkpoint:** no

**Depends on:** none

### `task-docs` — Dual-source TaskDocs module

**Status:** not-started

**Outside-in:** A named module that merges DB-registered docs with native docs-dir files (dedup by path, ordering preserved), with the SQLite store as one source behind a seam; `listDocsForTask` delegates to it.

**Feedback loop:** New unit tests for the merge/dedup-by-path + ordering rule without standing up SQLite; existing `task-store` doc tests and CLI `task show` / `skill re-enter` behavior stay green.

**Human checkpoint:** no

**Depends on:** none

### `cli-installer-split` — Split installer & consume lifted inference

**Status:** not-started

**Outside-in:** `trace init` + Claude `settings.json` wiring lives in its own module; `runTraceCli` and the SessionStart hook source session identity from the core `session-identity` module instead of inline CLI helpers.

**Feedback loop:** Existing `cli-link`, `claude-hook`, and `repo-skill` tests stay green; new/moved unit tests cover the extracted installer; `trace init` end-to-end behavior unchanged.

**Human checkpoint:** no

**Depends on:** session-identity
