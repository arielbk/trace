## `codex-plugin-scaffold` — 2026-06-11 17:50:00

**Status:** done
**Summary:** Added a Codex plugin manifest, repo-local Codex marketplace metadata, and a Codex-specific Trace skill. Added scaffold coverage that pins the Codex skill contract separately from the existing Claude Code plugin contract.
**Deviations:** The Codex marketplace path is repo-local metadata under `.agents/plugins/marketplace.json`; the plugin manifest itself is at the repo root under `.codex-plugin/plugin.json`.
**Handoff:** The Codex skill avoids Claude-only environment variables and instructs agents to resolve the bundled CLI from the plugin root, with a later installer slice responsible for rendering an absolute CLI path into local user-skill installs.

## `codex-init-installer` — 2026-06-11 17:51:29

**Status:** done
**Summary:** Extended `trace init` to install a local Codex user skill at `$HOME/.agents/skills/trace/SKILL.md`, rendering the repo's bundled `bin/trace.js` path into the installed copy. Updated installer coverage for first install, idempotent second run, and preservation of Claude settings.
**Deviations:** `trace init` remains a Claude plugin diagnostic, but now has one intentional local Codex side effect when `HOME` is available.
**Handoff:** The local install path follows the current Codex manual's user-skill directory (`~/.agents/skills`), not the older PRD's `~/.codex/skills` path.

## `codex-skill-flow` — 2026-06-11 17:52:45

**Status:** done
**Summary:** Added a CLI-level Codex flow test that scans a synthetic Codex home, binds the live `CODEX_THREAD_ID` with `skill work-on-task`, writes a decision doc to the reported docs directory, and re-enters the task. The existing scan, session identity, bind, docs, and manifest code already support the flow.
**Deviations:** The reported `taskDocsDir` is not created by `work-on-task`; the test creates it before writing fixture docs, matching existing Trace behavior.
**Handoff:** Keep Codex skill behavior as a command sequence over existing public CLI verbs; no new core/store command is needed for this slice.

## `cross-tool-reentry` — 2026-06-11 17:53:51

**Status:** done
**Summary:** Added public CLI tests proving Claude-created tasks can be re-entered from Codex with docs and prior Claude sessions intact, and Codex-created tasks can be re-entered from Claude through the same manifest path. No store or manifest changes were required.
**Deviations:** The reverse direction moved from "deferred unless cheap" to smoke-tested because existing behavior already supported it.
**Handoff:** `skill re-enter` builds the manifest before binding the current session, so cross-tool tests assert the prior tool remains `mostRecent: true` while the new tool session is bound afterward.

## `codex-docs-and-qa` — 2026-06-11 17:56:30

**Status:** done
**Summary:** Updated README and the Codex re-entry PRD to describe Codex plugin metadata, local user-skill install, backfill-based Codex capture, and smoke-tested reverse re-entry. Ran formatting, focused CLI suites, typechecks, lint, bundle build/smoke, full core tests, and diff hygiene.
**Deviations:** `pnpm --filter @trace/cli test:bundle` fails before repo code runs because it executes a Vitest test file through `node --test`; the same bundle suite passes through Vitest. Full `@trace/cli test` currently fails in unrelated `task-crud.test.ts` timeline/doc expectations that were outside this Codex change.
**Handoff:** `pnpm --filter @trace/cli build` refreshed `apps/cli/dist/*` and `bin/*`; keep those generated artifacts with the source changes.
