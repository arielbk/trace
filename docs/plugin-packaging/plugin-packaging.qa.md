# QA Plan: Plugin Packaging

## What was built

Trace is now packaged as a Claude Code plugin installed from this repo as a marketplace: the CLI and SessionStart hook bundle to portable JS artifacts, the store uses built-in `node:sqlite`, the plugin ships its manifest/hooks/skill/bin files, and setup docs point at plugin install instead of `pnpm link` plus `trace init`.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not action.

- [x] `pnpm --filter @trace/core test -- task-store.test.ts` — passed after the node-sqlite store adapter work through the unchanged public store API.
- [x] `pnpm --filter @trace/core test -- task-docs.test.ts` — passed against the node-sqlite-backed store.
- [x] `pnpm --filter @trace/core test -- token-totals.test.ts` — passed against the node-sqlite-backed store.
- [x] `pnpm --filter @trace/core check-types` — passed before the environment's dev install was lost.
- [x] Store smoke checks with `node:sqlite` — fresh DB create/register/assign and old-schema read/write continuity both passed.
- [x] `node --experimental-strip-types --check` for `packages/core/src/store.ts`, `packages/core/src/task-store.test.ts`, `packages/core/src/task-docs.test.ts`, and `packages/core/src/token-totals.test.ts` — syntax checks passed after the direct SQL migration path was added.
- [x] `pnpm --filter @trace/cli build` — emitted executable CLI and hook bundles under `apps/cli/dist` and plugin `bin/`.
- [x] `pnpm --filter @trace/cli test:bundle` — bundled CLI smoke test passed against a temp store with migrations travelling inside the artifact.
- [x] Direct bundled hook smoke — SessionStart hook artifact registered a Claude session and the bundled CLI read it back.
- [x] `node --test apps/cli/src/plugin-scaffold.test.ts` — plugin manifest, hook declaration, skill, and bundled artifact structure passed.
- [x] `node --test apps/cli/src/marketplace.test.ts` — marketplace contract passed after `.claude-plugin/marketplace.json` was added.
- [x] `node --test apps/cli/src/installer.test.ts apps/cli/src/plugin-scaffold.test.ts apps/cli/src/marketplace.test.ts apps/cli/src/bundle.test.ts` — installer/plugin/marketplace/bundle regression tests passed together.
- [x] `claude plugin validate .` — repo-level plugin validation passed.
- [x] Direct JSON/path checks — marketplace, plugin manifest, hooks, skill, and bundled artifacts were present and internally aligned.
- [x] Direct bundled `env -u HOME -u TRACE_DB node bin/trace.js init` smoke — printed the plugin-install diagnostic without requiring settings or a store.
- [x] `node --check` for touched CLI/core files — syntax checks passed for build, bundle, scaffold, marketplace, installer, trace dispatcher, task CRUD, migrations, and store files named in the log.
- [x] Bundle content checks — generated artifacts contain no `@trace/core`, `better-sqlite3`, `packages/core/drizzle`, or `migrationsDir` references.
- [x] Docs/setup reference checks — README and `skills/trace/SKILL.md` no longer contain `pnpm link --global` or `trace init` setup instructions, and stale hook-writing messages are absent from source, bundles, README, and the trace skill.
- [x] `git diff --check` — whitespace check passed in every slice.

## Human verification required

Items from slices with `Human checkpoint: yes`, plus anything from the log that needs a human eye, browser, device, or judgement call. Each item is a runbook — exact commands, exact entry point, steps, and pass criterion. Never make the human figure out how to run the thing.

### Setup

No local web server or worker is required for this QA plan. The repo does have a Vite web app (`cd /Users/arielbk/Projects/side/trace-v2 && pnpm --filter @trace/web dev`, default Vite entry point `http://localhost:5173/`), but plugin-packaging verification happens inside Claude Code's plugin UI and CLI environment.

Use a clean Claude Code config/profile if available so the marketplace-add and install path is not masked by an existing local plugin install. Start from this checkout:

```bash
cd /Users/arielbk/Projects/side/trace-v2
pnpm install
pnpm --filter @trace/cli build
```

- [ ] **`marketplace` needs-review: clean marketplace add + plugin install**
  - Run: use the Claude Code slash-command prompt in a fresh Claude Code session.
  - Open: Claude Code in `/Users/arielbk/Projects/side/trace-v2`.
  - Do: run `/plugin marketplace add github:arielbk/trace-v2`, then `/plugin install trace`.
  - Expect: Claude Code accepts the repo as marketplace `trace-v2`, installs plugin `trace`, and reports no manual file-copy, `pnpm link`, or `trace init` step.

- [ ] **Installed plugin registers a real SessionStart hook**
  - Run: use the installed plugin from the setup item, then start a brand-new Claude Code session or run `/clear` so a `SessionStart` event fires.
  - Open: Claude Code in any repo where the plugin is enabled.
  - Do: in that session, run the installed plugin CLI entry point:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" session list --unassigned
    ```
  - Expect: the fresh Claude Code session appears in the unassigned session list with a Claude tool identity and a plausible transcript reference. This is the runtime gate the `marketplace` slice left at `Status: needs-review`.

- [ ] **Installed trace skill is invocable through the plugin**
  - Run: use the same installed Claude Code plugin session.
  - Open: Claude Code in `/Users/arielbk/Projects/side/trace-v2` or another test repo.
  - Do: ask Claude Code, "We're working on plugin packaging QA." Let the trace skill bind the current session to a task.
  - Expect: the skill invokes the bundled plugin CLI, creates or finds a task, binds the current session, and reports a `taskDocsDir`. There should be no dependency on a global `trace` binary.

- [ ] **Full hero loop works with marketplace-installed plugin**
  - Run: use the same installed Claude Code plugin session.
  - Open: the `taskDocsDir` reported by the previous item.
  - Do: create a small doc such as `decisions.md` in that directory, run `/clear`, then ask Claude Code, "Re-enter plugin packaging QA."
  - Expect: re-entry returns a manifest containing the task, the decision doc path, and prior sessions newest-first with the most recent session flagged. The loop must work with no `pnpm link` and no `trace init`.

## Watch closely

Items where the log recorded deviations, snags, or unusual decisions. These are the most likely sources of subtle bugs — worth extra scrutiny during human verification.

- [ ] `store-node-sqlite`: `pnpm install --lockfile-only --offline` failed due missing cached workspace package metadata/tarballs and briefly removed the dev install; later Vitest/tsc reruns were blocked by missing cached `js-yaml`. Trust the focused checks listed above, but give dependency/lockfile state extra scrutiny on a clean machine.
- [ ] `store-node-sqlite`: after replacing the remaining Drizzle better-sqlite3 runtime import with direct `node:sqlite` SQL, verification used syntax checks plus direct public-API smoke tests rather than a full restored Vitest/typecheck pass.
- [ ] `cli-bundle`: full install/Vitest/typecheck/lint could not be restored after `node_modules` was removed; offline install lacked `eslint-config-prettier` metadata and network install could not resolve `registry.npmjs.org`.
- [ ] `cli-bundle`: the bundle test intentionally uses Node's built-in test runner and no new dependencies so it remains verifiable in the restricted environment.
- [ ] `plugin-scaffold`: the documented feedback loop is manual plugin installation in Claude Code; the agent substituted structural tests and direct hook smoke in the AFK environment, without marking the slice `needs-review`.
- [ ] `marketplace`: this slice is intentionally `Status: needs-review` with `Human checkpoint: yes`; automated contract validation passed, but clean Claude Code marketplace-add/install plus the full hero loop still need human QA.
- [ ] `retire-init-and-docs`: `pnpm --filter @trace/cli test -- installer.test.ts` could not run because `vitest` was absent from this workspace's `node_modules`; the installer regression was converted to Node's built-in test runner and verified there.
- [ ] All slices: the `/implement` resource templates were not present in the available skill/plugin directories during slice execution, so log entries followed the repo's existing Ralph log shape.
