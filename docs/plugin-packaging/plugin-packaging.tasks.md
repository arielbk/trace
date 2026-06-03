# Plugin Packaging

Repackage trace as a single installable Claude Code plugin — migrate the store
off the native `better-sqlite3` to built-in `node:sqlite` so the CLI bundles to
a portable JS artifact, then ship that bundle plus the skill and a `SessionStart`
hook in a plugin installed from the repo's own marketplace, with no `pnpm link`
and no `trace init`.

## Slices

### `store-node-sqlite` — Migrate store driver to `node:sqlite`

**Status:** done

**Outside-in:** `openTraceStore(databasePath)` and the `TaskStore` interface are unchanged; callers see no difference, but the store now opens databases via Node's built-in `node:sqlite` with no native dependency.

**Feedback loop:** Existing `packages/core` store suites (`task-store.test.ts`, `task-docs.test.ts`, `token-totals.test.ts`) pass unchanged through the public interface; plus a new test that opens a database created under the old schema and confirms reads/writes still work (migration continuity).

**Human checkpoint:** no

**Depends on:** none

---

### `cli-bundle` — Bundle CLI + hook to self-contained JS

**Status:** done

**Outside-in:** A build command emits self-contained JS artifacts for the `trace` CLI and the SessionStart hook with `@trace/core` inlined, no remaining native dependency, and migration SQL travelling with the bundle.

**Feedback loop:** Smoke test runs the bundled CLI artifact against a temp store with a representative command (`skill work-on-task`) and asserts expected stdout, proving the artifact runs with no source tree and no native deps present (migrations apply from the bundle).

**Human checkpoint:** no

**Depends on:** store-node-sqlite

---

### `plugin-scaffold` — Plugin manifest + hooks.json + skill + bundle

**Status:** done

**Outside-in:** A Claude Code plugin definition in the repo: plugin manifest, `hooks.json` declaring the `SessionStart` hook against the bundled artifact via the plugin-root path, the trace skill, and the bundled CLI — installable locally with no PATH dependency and no npx.

**Feedback loop:** manual: install the plugin locally, start a fresh Claude Code session, confirm `trace session list --unassigned` shows the new session (hook fired) and the trace skill is invocable.

**Human checkpoint:** no

**Depends on:** cli-bundle

---

### `marketplace` — Repo installable as a marketplace

**Status:** needs-review

**Outside-in:** A marketplace definition so `/plugin marketplace add github:arielbk/trace-v2` followed by plugin install registers the hook and skill in one step.

**Feedback loop:** manual: on a clean setup, marketplace-add + install registers the SessionStart hook and skill with zero manual steps, and the full hero loop (work-on-task → `/clear` → re-enter) runs end-to-end with no `pnpm link` and no `trace init`.

**Human checkpoint:** yes

**Depends on:** plugin-scaffold

---

### `retire-init-and-docs` — Remove `trace init` hook-wiring + update docs

**Status:** done

**Outside-in:** Installing the plugin is the only documented setup path; `trace init` no longer writes a hook into `settings.json`, and README + the skill's "CLI Setup" section describe plugin install instead of `pnpm link --global` + `trace init`.

**Feedback loop:** Updated/removed installer tests pass; README and `skills/trace/SKILL.md` no longer reference `pnpm link --global` or `trace init` as setup steps.

**Human checkpoint:** no

**Depends on:** plugin-scaffold
