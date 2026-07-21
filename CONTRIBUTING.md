# Contributing to Trace

This covers wiring Trace into your own tooling and working on Trace itself. For
what Trace is and how to use it, see the [README](./README.md).

## What's underneath

Trace is a local CLI and a SQLite file, with no model calls of its own, so Trace
itself never spends tokens.

- The **`trace` CLI**, published to npm and installed globally. It owns the
  skills and hooks installed by `trace setup`.
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

Build and globally link the CLI package, then let the same setup flow users run
install this checkout's bundled skills and hooks:

```sh
corepack pnpm --filter @arielbk/trace build
cd apps/cli && corepack pnpm link --global
TRACE_CLI_PATH="$(command -v trace)" trace setup --yes
```

The explicit `TRACE_CLI_PATH` keeps local hooks pointed at the global shim;
otherwise the link realpaths into the source checkout, which managed setup
correctly rejects. Rebuild after CLI or skill changes and rerun that setup
command to reconcile the installed targets. Start a fresh session when testing
`SessionStart`, which only fires at startup. Point `TRACE_DB` at a throwaway path
when a test should not touch your real store (`~/.trace/trace.sqlite`). Testing
the board also requires `corepack pnpm --filter @trace/web build` before the CLI
build.

## Releasing

A release publishes one package, `@arielbk/trace`, to npm. The tarball contains
the CLI, web UI, and canonical skills tree; `trace setup` installs those bundled
artifacts. Repository plugin manifests remain compatibility metadata and are not
versioned release artifacts.

One command stamps `apps/cli/package.json`, builds the web UI and CLI, packs the
tarball, and publishes it. A dry-run restores the original package version when
it finishes, so the same `--bump` command selects the same version for the real
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
