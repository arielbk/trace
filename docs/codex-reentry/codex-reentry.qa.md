# QA Plan: Codex re-entry

## What was built

Trace now ships a Codex-facing plugin/skill path alongside the existing Claude
Code plugin. Codex can backfill sessions, bind/re-enter Trace tasks, and use the
same manifest path for Claude -> Codex and Codex -> Claude context handoff.

## Already verified by the agent

These were run during implementation and passed. Listed for confidence, not
action.

- [x] `pnpm exec prettier --write README.md docs/codex-reentry/codex-reentry.prd.md docs/codex-reentry/codex-reentry.tasks.md docs/codex-reentry/codex-reentry.log.md apps/cli/src/plugin-scaffold.test.ts apps/cli/src/installer.test.ts apps/cli/src/installer.ts apps/cli/src/codex-scan.test.ts apps/cli/src/cross-tool-reentry.test.ts codex/skills/trace/SKILL.md .codex-plugin/plugin.json .agents/plugins/marketplace.json` - touched files formatted.
- [x] `pnpm --filter @trace/cli test -- --run src/plugin-scaffold.test.ts src/installer.test.ts src/codex-scan.test.ts src/cross-tool-reentry.test.ts` - 4 files, 14 tests passed.
- [x] `pnpm --filter @trace/core test -- --run src/session-identity.test.ts src/codex-adapter.test.ts src/transcript-adapter.test.ts` - 3 files, 23 tests passed.
- [x] `pnpm --filter @trace/cli check-types` - TypeScript passed.
- [x] `pnpm --filter @trace/core check-types` - TypeScript passed.
- [x] `pnpm --filter @trace/cli build` - refreshed bundled CLI and hook artifacts.
- [x] `pnpm --filter @trace/cli test -- --run src/bundle.test.ts` - bundle smoke passed under Vitest.
- [x] `pnpm --filter @trace/cli lint` - ESLint passed.
- [x] `pnpm --filter @trace/core test` - full core suite passed, 13 files and 140 tests.
- [x] `git diff --check` - no whitespace errors.

## Human verification required

### Setup

Run from this repo checkout:

```bash
cd /Users/arielbk/Projects/side/trace-v2
pnpm install
pnpm --filter @trace/cli build
node bin/trace.js init
```

- [ ] **Codex local skill is visible in a fresh Codex session**
  - Run: use the Setup commands above, then restart Codex or start a new Codex
    thread in this repo.
  - Open: Codex skill picker / available skills for the new thread.
  - Do: look for the `trace` skill installed from
    `~/.agents/skills/trace/SKILL.md`.
  - Expect: Codex can load the `trace` skill and its instructions include
    `session scan --codex`, `skill work-on-task`, and `skill re-enter`.

- [ ] **Real Codex re-entry loop**
  - Run: in a Codex thread in this repo, ask Codex to use the Trace skill for a
    small throwaway task, then ask it to re-enter that exact task title.
  - Open: `~/.trace/trace.sqlite` through `node bin/trace.js task list` if you
    want to inspect the store.
  - Do: confirm the skill first backfills Codex sessions, then binds via
    `skill work-on-task`, then re-enters via `skill re-enter`.
  - Expect: the task exists, the Codex session is assigned, and re-entry prints
    docs/session manifest context without raw transcript paste.

- [ ] **Codex plugin marketplace metadata**
  - Run: from Codex plugin UI or CLI plugin marketplace flow, add this repo's
    local marketplace if your Codex build supports repo-local marketplace files.
  - Open: the plugin entry named `trace`.
  - Do: inspect the plugin details.
  - Expect: it points at `.codex-plugin/plugin.json` and exposes the bundled
    `codex/skills/trace/SKILL.md`.

## Watch closely

- [ ] `pnpm --filter @trace/cli test:bundle` currently fails before Trace code
      runs because the script invokes `src/bundle.test.ts` with `node --test` even
      though the file uses Vitest APIs. The equivalent Vitest invocation passes.
- [ ] `pnpm --filter @trace/cli test` currently fails in unrelated
      `task-crud.test.ts` cases around timeline ordering and captured-doc timeline
      inclusion. Focused Codex suites, lint, typechecks, bundle smoke, and full core
      tests pass.
- [ ] The Codex user-skill install intentionally targets `~/.agents/skills`,
      matching current Codex docs, not the older PRD's `~/.codex/skills` path.
