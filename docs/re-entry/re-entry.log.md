## `doc-store` — 2026-05-30 01:53:57 CEST

**Status:** done
**Summary:** Added trace-native task docs rooted at the trace home next to the resolved database path (`tasks/<taskId>/docs`). `listDocsForTask` now returns files written directly into that directory plus externally registered `add-doc` paths, de-duplicated by path, and existing CLI `task show` / `skill re-enter` output surfaces the combined list.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape used elsewhere in the repo. The first full `@trace/cli` test run timed out in the pre-existing repo-skill smoke test while checks were running in parallel; rerunning `@trace/cli` by itself passed.
**Handoff:** Verified with red/green focused core tests for native docs, union/de-duplication, and missing doc directories; a CLI acceptance test for `task show` and `skill re-enter`; full `@trace/core` test suite; full `@trace/cli` test suite; `@trace/core` typecheck; `@trace/cli` typecheck; and Prettier check on touched files.

## `transcript-tail` — 2026-05-30 01:57:31 CEST

**Status:** done
**Summary:** Added a core transcript tail reader that extracts recent user/assistant message text from Claude and Codex JSONL with a shared `{ role, text }` shape, returning an empty list for malformed, empty, or missing transcripts. Added `trace session tail <id> [--limit N]`, which resolves the registered session transcript and prints clean `role: text` lines.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape used in this file. Existing Claude/Codex fixtures were extended with message events while preserving adapter token expectations.
**Handoff:** Verified with a red/green focused core transcript-tail test over both fixtures plus malformed/empty/missing cases; a CLI smoke test for `session tail --limit`; full `@trace/core` test suite; full `@trace/cli` test suite; `@trace/core` typecheck; `@trace/cli` typecheck; and Prettier check on touched TypeScript/Markdown files. Prettier cannot infer a parser for the touched `.jsonl` fixtures, so those fixture files were excluded from the formatting check.
