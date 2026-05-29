## `doc-store` — 2026-05-30 01:53:57 CEST

**Status:** done
**Summary:** Added trace-native task docs rooted at the trace home next to the resolved database path (`tasks/<taskId>/docs`). `listDocsForTask` now returns files written directly into that directory plus externally registered `add-doc` paths, de-duplicated by path, and existing CLI `task show` / `skill re-enter` output surfaces the combined list.
**Deviations:** The `/implement` resource templates were not present in the available skill/plugin directories, so this entry follows the existing Ralph log shape used elsewhere in the repo. The first full `@trace/cli` test run timed out in the pre-existing repo-skill smoke test while checks were running in parallel; rerunning `@trace/cli` by itself passed.
**Handoff:** Verified with red/green focused core tests for native docs, union/de-duplication, and missing doc directories; a CLI acceptance test for `task show` and `skill re-enter`; full `@trace/core` test suite; full `@trace/cli` test suite; `@trace/core` typecheck; `@trace/cli` typecheck; and Prettier check on touched files.
