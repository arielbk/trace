# PRD: Plugin Packaging

## Problem Statement

Setting up trace is a multi-step manual chore. Today a user must clone the repo,
run `pnpm install`, then `pnpm link --global` to put the `trace` command on
their PATH, then run `trace init` to wire the `SessionStart` hook into
`~/.claude/settings.json` and confirm the skill is discoverable. The skill is
distributed separately (via npx-skills into a project's `.claude/skills/`).
That's three distinct install surfaces — a global binary, a settings-file hook,
and a skill — each with its own failure mode, and all of them assume a local
checkout. There's no path to "I want to use trace" → "trace works" without
cloning and running package-manager commands.

## Solution

Ship trace as a single installable **Claude Code plugin**. The plugin bundles
everything the hero loop needs — the CLI as one self-contained JS file, the
trace skill, and a `SessionStart` hook declared in the plugin's own
`hooks.json`. Installing the plugin registers the hook and the skill in one
step, with no `pnpm link` and no `trace init`. The repo itself acts as the
plugin marketplace, so a user runs a marketplace-add plus install and the full
work-on-task → `/clear` → re-enter loop works immediately.

The one thing standing between trace and a portable artifact is the native
`better-sqlite3` dependency: a plugin is just a git repo and never runs
`npm install`, so the shipped CLI must run as-is, and a native `.node` binary
can't be bundled into a single JS file. We remove that blocker by migrating the
store to Node's built-in `node:sqlite`, which has no native install step and is
stable on the Node versions trace targets.

## User Stories

1. As a new user, I want to install trace by adding a marketplace and running a
   plugin install, so that I don't have to clone the repo or run package-manager
   commands.
2. As a new user, I want the `SessionStart` hook registered automatically when I
   install the plugin, so that my sessions are recorded without editing
   `settings.json` or running `trace init`.
3. As a new user, I want the trace skill available immediately after install, so
   that "we're working on X" and "re-enter X" work without a separate skill
   install.
4. As a user on any platform with a modern Node, I want the plugin to run
   without platform-specific native binaries, so that install never fails on an
   ABI or prebuild mismatch.
5. As a user, I want my existing `~/.trace` store to keep working after the
   store migrates to `node:sqlite`, so that I don't lose recorded tasks and
   sessions.
6. As a maintainer, I want the bundled CLI built from the existing
   `apps/cli` + `packages/core` source, so that there's one source of truth and
   the bundle is a build artifact, not a fork.
7. As a maintainer, I want `trace init`'s hook-wiring removed once the plugin
   declares the hook, so that there's a single mechanism for hook registration.

## Implementation Decisions

### Store driver migration (`packages/core`)

- Replace the `better-sqlite3` + `drizzle-orm/better-sqlite3` driver layer in
  the store module with Node's built-in `node:sqlite`. The store's public
  interface (`openTraceStore`, the `TaskStore` type, and all of its methods)
  stays identical — this is a driver swap behind a stable interface, the kind of
  deep-module boundary that should be invisible to callers.
- Decide during planning whether drizzle exposes a `node:sqlite`-compatible
  driver. If it does, keep drizzle and swap only the driver/migrator imports. If
  it does not, replace the drizzle query calls (a small, enumerable set:
  insert/select/update/delete against `tasks`, `sessions`, `taskDocs`) with
  direct `node:sqlite` prepared statements. Either way the schema and column
  names are unchanged, so existing `~/.trace/trace.sqlite` files stay readable.
- Preserve the migration behaviour: the store applies pending migrations on
  open. The migration SQL currently lives as files under the core package's
  `drizzle/` directory and is resolved by a runtime path helper. The shipped
  bundle has no source tree, so the migrations must travel with the artifact —
  either inlined into the bundle or copied alongside it and resolved relative to
  the bundle. Keep WAL journal mode and foreign-keys pragmas.

### CLI bundling (`apps/cli`)

- Add a build step that bundles the CLI entry point and the session-start hook
  entry point into self-contained JS files with `@trace/core` inlined and no
  remaining native dependencies. esbuild is the expected tool. Output is a
  build artifact consumed by the plugin.
- The hook currently imports the CLI's dispatcher directly; the bundle must
  cover both the `trace` command and the SessionStart hook so the plugin can
  invoke each.

### Plugin packaging (new surface)

- Add a Claude Code plugin definition to the repo: the plugin manifest, a
  `hooks.json` declaring the `SessionStart` hook, the trace skill, and the
  bundled CLI artifact. Hook and skill invoke the bundled CLI via the
  plugin-root path the harness exposes to plugins — no PATH dependency, no npx.
- Add a marketplace definition so the repo is installable as a marketplace
  directly from its GitHub remote.
- The `SessionStart` hook entry in `hooks.json` runs the bundled hook with the
  user's Node, replacing the `settings.json` hook that `trace init` used to
  write.

### Removal / cleanup

- Remove `trace init`'s hook-wiring into `settings.json` — the plugin's
  `hooks.json` is now the single registration mechanism. Decide during planning
  whether `trace init` is deleted entirely or reduced to a diagnostic/no-op.
- Update README setup instructions and the skill's "CLI Setup" section to
  describe plugin install instead of `pnpm link --global` + `trace init`.

## Testing Decisions

- The store migration is the highest-value test target. `packages/core` already
  has store tests (`task-store.test.ts`, `task-docs.test.ts`,
  `token-totals.test.ts`) that exercise `openTraceStore` against a real
  temp-file sqlite database. These tests assert behaviour through the public
  interface, so they should pass unchanged after the driver swap — that's the
  regression guarantee. Add a test that opens a database created under the old
  schema and confirms reads/writes still work (migration continuity).
- Migration application on open should be covered: opening a fresh database
  creates the schema; opening an already-migrated database is a no-op.
- The bundle is verified by a smoke test: run the bundled CLI artifact with a
  representative command (e.g. `skill work-on-task`) against a temp store and
  assert the expected stdout, proving the artifact runs with no native deps and
  no source tree present.
- Plugin install itself (marketplace add + install + hook firing) is validated
  manually against the "Done when" loop rather than unit-tested.

## Out of Scope

- Publishing to npm or any registry; real `npx tracernet`. The plugin install
  via marketplace is the only distribution path in this task.
- The Codex entry point (session hook + skill wrapper). The store and manifest
  stay tool-agnostic, but no Codex install surface is built here.
- Per-platform native-binary distribution / prebuilds. The `node:sqlite`
  migration exists precisely to avoid this.
- Any change to the hero loop's behaviour, the re-entry manifest format, or the
  skill's verbs. This task changes how trace is installed and what backs the
  store, not what it does.

## Open Questions

- Does drizzle ship a `node:sqlite`-compatible driver on the targeted version,
  or do we drop drizzle in the store in favour of direct `node:sqlite` prepared
  statements? Resolve during planning by checking the installed drizzle version.
- Is `trace init` deleted outright, or kept as a diagnostic command (e.g.
  "report where the store and skill live") once it no longer writes hooks?
- What is the minimum Node version the plugin declares, given `node:sqlite`
  stability requirements? The repo currently claims `engines: node >=18`, which
  is below `node:sqlite`'s availability and must be raised.
