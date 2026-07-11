# Contributing to Trace

This covers wiring Trace into your own tooling and working on Trace itself. For
what Trace is and how to use it, see the [README](./README.md).

## What's underneath

Trace is a local CLI and a SQLite file, with no model calls of its own, so Trace
itself never spends tokens.

- The **`trace` CLI**, published to npm and resolved per-call by the skills via a
  version-pinned `npx @arielbk/trace@<version>` (no global install, no `PATH`
  setup).
- A **SQLite store** at `~/.trace/trace.sqlite` recording tasks and the sessions
  bound to them.
- **Transcript adapters** (one per agent) that read session transcripts so
  re-entry can surface the tail of a prior session on demand. Supporting a new
  agent means writing an adapter; nothing above it changes.
- **Capture into one store**, either live (where an agent exposes a session-start
  hook) or by backfill (where it doesn't).
- Per-task docs at `~/.trace/tasks/<slug>/docs/`, the known place re-entry looks.

## Registering spawned children

A spawner that launches separate child CLI sessions can attribute those children
without knowing anything about Trace internals. Capture each child session id
from the child tool's machine-readable stream, then run:

```sh
trace session set-parent <child-session-id> --parent <parent-session-id> --origin spawned
```

The parent session must already exist in the Trace store. The child may already
exist, or it may be unknown when the command runs. Unknown children are seeded as
virtual Codex sessions with a `codex:<child-session-id>` transcript URI; a later
`trace session register` or Codex scan enriches the row with the real transcript
and tool details without dropping the parent attribution.

For generic spawners, expose a per-child hook named `TRACE_SPAWN_HOOK`. Treat an
unset hook as a no-op. When it is set, substitute `{parent}` and `{child}` with
the captured ids and invoke it exactly once per child:

```sh
TRACE_SPAWN_HOOK='trace session set-parent {child} --parent {parent} --origin spawned'
```

Ralph is the worked example of this contract: it captures Claude children from
`session_id` events and Codex children from `thread.started.thread_id`, records
the `<parent><tab><child>` pair in its own sink, then runs the hook. Any other
spawner can follow the same pattern with its own way of discovering child ids.

## Development

This is a [Turborepo](https://turborepo.dev) monorepo (pnpm workspaces). It
requires **Node 22+** and **pnpm 11**; invoke pnpm via `corepack` so you get the
pinned version regardless of any globally shimmed pnpm.

```sh
corepack pnpm install        # install dependencies
corepack pnpm -r test        # run the test suites (per-package)
corepack pnpm check-types    # typecheck all packages
```

The skill-routing eval (`pnpm eval`) is a separate, quota-costing report that
drives real `claude -p` calls against a sandbox config dir. See
[`evals/README.md`](./evals/README.md) for setup and how to run it.

- `apps/cli`: the `trace` CLI
- `apps/web`: the board (the local web UI)
- `packages/core`: the store, transcript adapters, and re-entry manifest
- `plugin/skills/`: the one canonical skills tree, shared by both hosts. The
  Claude plugin (manifest at `.claude-plugin/plugin.json`) reaches it via the
  nested `./plugin/skills/` path; the Codex plugin roots at `plugin/` itself
  (manifest `plugin/.codex-plugin/plugin.json`, surfaced through
  `.agents/plugins/marketplace.json`) and reads `./skills/`. No generated mirror.
- The only per-host skill, `trace`, is a host-neutral dispatcher
  (`plugin/skills/trace/SKILL.md`) that points at `resources/claude.md` or
  `resources/codex.md` for the host-specific binding flow.

## Testing skills and the CLI locally

Trace ships through two coupled channels — skills by git (the marketplace
install tracks the repo's default branch) and the CLI by npm (skills pin
`npx @arielbk/trace@<version>`) — so out of the box, a skill change is only
live once it lands on main and a CLI change once it's published. The local dev
flow below removes both requirements: no merge, no publish.

### One-time setup: serve the plugin from your working tree

Install the plugin from a local-path marketplace instead of GitHub. Inside a
Claude Code session:

```
/plugin marketplace remove trace        (if currently installed from GitHub)
/plugin marketplace add /path/to/your/trace-v2/checkout
/plugin install trace@trace
/reload-plugins
```

Skill markdown and `hooks/hooks.json` are now served live from your checkout —
a skill-only change is testable with just `/reload-plugins`. Marketplaces and
plugin installs are **per Claude instance** (each `CLAUDE_CONFIG_DIR`, e.g.
`~/.claude` vs `~/.claude-infinum`, has its own), so repeat this in each
instance that should track your tree. Optionally keep one instance on the
GitHub marketplace to dogfood the exact install real users get.

Unstamped (the default state), the tree's pins still say
`npx @arielbk/trace@<version>`, so daily use keeps running the **published**
CLI even though skills are served locally.

### Per-iteration loop: point the pins at your local build

```sh
corepack pnpm --filter @arielbk/trace build   # if CLI code changed
corepack pnpm dev:stamp                       # pins -> node <checkout>/apps/cli/dist/trace.js
# /reload-plugins in the session, or start a fresh session when
# testing the SessionStart hook (it only fires at startup)
# ...exercise the real flow...
corepack pnpm dev:unstamp                     # restore published pins
```

Notes:

- Both commands are idempotent and print the files they touched.
- `dev:unstamp` restores the version from `apps/cli/package.json`, so a
  round-trip leaves the tree byte-identical.
- Point `TRACE_DB` at a throwaway path when a test shouldn't touch your real
  store (`~/.trace/trace.sqlite`).
- Testing the board (`trace serve`) also needs the web assets:
  `corepack pnpm --filter @trace/web build` before the CLI build.
- Don't commit stamped hunks. If one slips through, the release script's pin
  verification fails the release before anything ships.

## Releasing

A release publishes one package, `@arielbk/trace`, to npm, and that's the only
thing distributed. The plugins aren't separate artifacts: the skills and the
`SessionStart` hook invoke the CLI through an **exact-pinned**
`npx @arielbk/trace@<version>` (never `@latest`), so a given commit always calls
a known CLI version. The catch is that those pins live in several files (every
`plugin/skills/*/SKILL.md`, the `trace` skill's `resources/codex.md`, and
`hooks/hooks.json`), and they must all move in lockstep with the published
version, or the plugin calls a CLI that doesn't exist yet.

That lockstep is what `release:trace` automates, so **don't hand-edit those
`npx @arielbk/trace@…` pins**. The release script rewrites them and then verifies
every one matches, failing the release on any drift. The pinned files aren't
hand-listed: the release script discovers them by scanning `plugin/skills/**` and
`hooks/` for the `npx @arielbk/trace@…` pin, so a new skill or skill resource is
picked up automatically.

One command does the whole thing: stamp every pin (plus `apps/cli/package.json`
and the Codex plugin manifest), build the web UI and the CLI, `npm pack`, and
publish:

```sh
# Always dry-run first: stamps, builds, packs, and runs `npm publish --dry-run`
corepack pnpm release:trace -- --bump patch --dry-run

# Real publish (drop --dry-run). Requires npm auth for the @arielbk scope.
corepack pnpm release:trace -- --bump patch
```

Pick the version with either `--bump patch|minor|major` (computed from the
current `apps/cli/package.json`) or `--version x.y.z` for an explicit one, not
both. A real publish needs write access to the `@arielbk` npm scope configured in
your `~/.npmrc`; published versions are immutable, so let the dry-run pass before
dropping the flag.
