# Contributing to EQNX

This covers wiring EQNX into your own tooling and working on EQNX itself. For
what EQNX is and how to use it, see the [README](./README.md).

## What's underneath

EQNX is a local CLI and a SQLite file, with no model calls of its own, so EQNX
itself never spends tokens.

- The **`trace` CLI**, published to npm and installed globally. It owns the
  skills and hooks installed by `eqnx setup`.
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
without knowing anything about EQNX internals. Capture each child session id
from the child tool's machine-readable stream, then run:

```sh
eqnx session set-parent <child-session-id> --parent <parent-session-id> --origin spawned
```

The parent session must already exist in the EQNX store. The child may already
exist, or it may be unknown when the command runs. Unknown children are seeded as
virtual Codex sessions with a `codex:<child-session-id>` transcript URI; a later
`eqnx session register` or Codex scan enriches the row with the real transcript
and tool details without dropping the parent attribution.

For generic spawners, expose a per-child hook named `TRACE_SPAWN_HOOK`. Treat an
unset hook as a no-op. When it is set, substitute `{parent}` and `{child}` with
the captured ids and invoke it exactly once per child:

```sh
TRACE_SPAWN_HOOK='eqnx session set-parent {child} --parent {parent} --origin spawned'
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
- `skills/`: the one canonical skills tree, shared by every host. The CLI build
  copies it to `apps/cli/dist/skills/` so the npm tarball ships it, and
  `eqnx setup` installs from whichever of the two it finds. No generated
  mirror, and no plugin manifest — the marketplace install channel was retired
  in favour of the global CLI plus `eqnx setup`.
- The only per-host skill, `trace`, is a host-neutral dispatcher
  (`skills/trace/SKILL.md`) that points at `resources/claude.md` or
  `resources/codex.md` for the host-specific binding flow.

## Testing skills and the CLI locally

Build and globally link the CLI package, then let the same setup flow users run
install this checkout's bundled skills and hooks:

```sh
corepack pnpm --filter @eqnx/cli build
cd apps/cli && corepack pnpm link --global
TRACE_CLI_PATH="$(command -v trace)" eqnx setup --yes
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

A release publishes one package, `@eqnx/cli`, to npm. The tarball contains
the CLI, web UI, and canonical skills tree; `eqnx setup` installs those bundled
artifacts.

One command stamps `apps/cli/package.json`, builds the web UI and CLI, packs the
tarball, and publishes it. A dry-run restores the original package version when
it finishes, so the same `--bump` command selects the same version for the real
publish:

```sh
# Always dry-run first: stamps, builds, packs, and runs `npm publish --dry-run`
corepack pnpm release:eqnx -- --bump patch --dry-run

# Real publish (drop --dry-run). Requires npm auth for the @eqnx scope.
corepack pnpm release:eqnx -- --bump patch
```

Pick the version with either `--bump patch|minor|major` (computed from the
current `apps/cli/package.json`) or `--version x.y.z` for an explicit one, not
both. A real publish needs write access to the `@eqnx` npm scope configured in
your `~/.npmrc`; published versions are immutable, so let the dry-run pass before
dropping the flag.
