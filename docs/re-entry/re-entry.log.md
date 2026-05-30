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

## `re-entry-payload` — 2026-05-30 02:01:41 CEST

**Status:** done
**Summary:** Added a core re-entry manifest API that returns the task header, decision-doc pointers from both trace-native and external sources, and assigned session transcript pointers ordered newest-first with the most-recent session flagged. `trace skill re-enter X` now renders that manifest with explicit empty doc/session sections instead of a flat context dump.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape used in this file. Existing skill helper and CLI smoke assertions were updated from the old flat context format to the manifest format.
**Handoff:** Verified with red/green focused core manifest tests for docs, newest-first sessions, most-recent flagging, missing task, and empty sections; CLI manifest tests for empty sections, doc pointers, session order, and most-recent flags; full `@trace/core` test suite; full `@trace/cli` test suite; `@trace/core` typecheck; `@trace/cli` typecheck; and Prettier check on touched TypeScript/Markdown files.

## `re-entry-skill` — 2026-05-30 02:05:17 CEST

**Status:** needs-review
**Summary:** Updated the Claude Trace skill prose with the re-entry consumption protocol: call the helper, read decision docs first, fall back to the most-recent transcript tail only when docs are insufficient, never paste raw transcripts, and leave the Codex entry point deferred. `trace skill work-on-task` now prints the task doc directory as `taskDocsDir: <path>`, and the helper forwards that output so agents know where to write task artifacts.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape used in this file. The slice has a required human prose/manual checkpoint, so it is settled as `needs-review` after automated checks passed.
**Handoff:** Verified with a red/green repo skill smoke test for helper forwarding and protocol prose, the existing CLI work-on-task/re-enter smoke tests updated for `taskDocsDir`, the full `@trace/cli` test suite, `@trace/cli` typecheck, and Prettier check on touched files. Manual follow-up: review the skill prose and run a live Claude `work-on-task` flow that writes into `taskDocsDir`, then confirm `re-enter` surfaces the doc.
