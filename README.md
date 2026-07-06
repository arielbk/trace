# Trace

**Pick up any task exactly where you left off — without re-explaining it.**

You work on something with an AI agent: you make decisions, write code, build up
a head full of context. Then the session ends. Days later you — or a fresh agent
with an empty memory — come back and have to reconstruct all of it from scrollback
and guesswork.

Trace removes that step. It quietly records each agent session against a _task_,
gives you a known place to drop decision docs and plans, and lets a brand-new
session reload the whole thread with one sentence:

> Re-enter the checkout flow.

The agent gets back the task, its decision docs, a distilled summary of where you
left off, and pointers to prior sessions — newest first. No pasting transcripts,
no "remind me what we decided."

Trace doesn't care which agent you use. It talks to each one through an adapter,
so a task you start in one session you can re-enter in another — even a different
agent — and everything lands in the same store underneath.

## Setup

Install the agents you use. They share one SQLite store and one re-entry
manifest, so a task is visible from whichever session you re-enter on.

### Claude Code

Trace installs as a Claude Code plugin. From inside Claude Code, add this repo as
a marketplace, then install the plugin (two separate commands):

```sh
/plugin marketplace add arielbk/trace-v2
/plugin install trace@trace-v2
```

The plugin wires up the skills and a `SessionStart` hook that captures each
session live — no global CLI link or manual settings edit. The skills and hook
invoke the CLI on demand via a version-pinned `npx @arielbk/trace@<version>`, so
there's nothing to build or link. Reload plugins to activate, then ask the agent
to confirm:

```sh
/reload-plugins
```

> Are we currently in a trace session?

The agent should confirm the session is being tracked.

### Codex

Trace installs as a Codex plugin, mirroring Claude. Add this repo as a
marketplace, then install the plugin (two separate commands):

```sh
codex plugin marketplace add arielbk/trace-v2
codex plugin add trace@trace-v2
```

The marketplace source is the repo itself, and Codex installs from the same
canonical skills tree as Claude — so it ships the full skill set (not just
`trace`); each skill invokes the CLI via the same version-pinned
`npx @arielbk/trace@<version>`.
Codex has no live session-start slot, so the skill captures sessions by backfill —
it runs `trace session scan --codex` before it binds or re-enters a task. Same
store, same manifest; just a different capture path.

### Cursor

Cursor (the IDE) has no plugin marketplace and no session-start hook, so there's
nothing to install — and like Codex, capture is **pull-time**: trace reads
Cursor's local session store (`state.vscdb`) on demand and resolves the session
you're in from the directory the command runs in. No env var, no Cursor
cooperation.

To let Cursor's own agent drive the same loop, point it at trace from your
project's `AGENTS.md` (Cursor reads it):

```md
## Trace
When I name a piece of work I'm starting or resuming, bind it with Trace before
planning: run `npx @arielbk/trace@<version> skill work-on-task "<the task>"`.
To resume a task I name, run `npx @arielbk/trace@<version> skill re-enter <slug>`.
```

The agent then binds and re-enters through the same CLI as the other hosts —
each invocation backfills the current Cursor session from `state.vscdb`. You can
also run those commands yourself from Cursor's integrated terminal. A live
Cursor hook (auto-capture, no invocation) is a follow-up; for now capture
happens when the skill runs.

> Cursor does not record per-message token *spend* in its local store, so the
> board shows a session's context-window usage instead of an input/output total.

## How it works

It's a loop. Walk it once and the value is obvious:

1. **Say what you're working on.** "We're working on the checkout flow." Trace
   binds the session to a task (creating it if needed) and tells you where the
   task's docs live.
2. **Drop docs where re-entry can find them.** Any spec, plan, or note you write
   into that task's docs directory is associated with the task automatically — no
   registration step.
3. **Wrap up.** When you're done for the session, Trace distills it into the
   task's living state file, so the next agent reads a summary, not a transcript.
4. **Come back and re-enter.** In a fresh session — tomorrow, next week, a clean
   `/clear`, or a different agent entirely — name the task. The agent reloads the
   state file, the docs, and only if needed the tail of the last session, then
   keeps going.

If you ever start real work in a session that _isn't_ tracked, Trace notices and
offers to bind it — so you don't have to remember to.

## The skills

Trace exposes the loop as focused skills, each firing on one kind of intent so
routing stays predictable:

| Skill                   | Fires when you…                                       | What it does                                                                                                 |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **trace**               | say you're working on / scoping / defining something  | binds the session to a task (creating it if absent); nudges you when an untracked session is doing real work |
| **trace-reenter**       | name a task by its exact slug or title                | reloads that task's full context from its re-entry manifest                                                  |
| **trace-recall**        | gesture vaguely at past work ("that archiving thing") | figures out _which_ task you mean, then re-enters it                                                         |
| **trace-handoff**       | wrap up, hand off, or start a new chat                | distills the session into the task's living `state.md`                                                       |
| **trace-doc-placement** | write a spec, PRD, plan, or note                      | lands the file in the current task's docs directory                                                          |
| **trace-board**         | ask to open the board                                 | starts a local web UI for browsing tasks                                                                     |

Two front doors resolve a task's _identity_ differently — `trace-reenter` (you
name it exactly) and `trace-recall` (you gesture at it) — and both pour into one
shared re-entry core that loads context the same way. How much of this surface an
agent gets depends on the agent: some expose every intent as its own skill,
others carry the whole loop in a single entry skill.

## What's underneath

- The **`trace` CLI**, published to npm and resolved per-call by the skills via a
  version-pinned `npx @arielbk/trace@<version>` — no global install, no `PATH` setup.
- A **SQLite store** at `~/.trace/trace.sqlite` recording tasks and the sessions
  bound to them.
- **Transcript adapters** — one per agent — that read session transcripts so
  re-entry can surface the tail of a prior session on demand. Supporting a new
  agent means writing an adapter; nothing above it changes.
- **Capture into one store**, either live (where an agent exposes a session-start
  hook) or by backfill (where it doesn't).
- Per-task docs at `~/.trace/tasks/<slug>/docs/` — the known place re-entry looks.

## Registering Spawned Children

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

## Status

Same-tool re-entry — work in an agent, clear, re-enter, keep going — is the core
loop and works today. Cross-tool re-entry rides the shared manifest: a task
worked in one agent can be re-entered from another. The agents supported right
now are **Claude Code**, **Codex**, and **Cursor** (macOS; pull-time capture, no
live hook yet); more are a matter of adding adapters.

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
drives real `claude -p` calls against a sandbox config dir — see
[`evals/README.md`](./evals/README.md) for setup and how to run it.

- `apps/cli` — the `trace` CLI
- `packages/core` — the store, transcript adapters, and re-entry manifest
- `plugin/skills/` — the one canonical skills tree, shared by both hosts. The
  Claude plugin (manifest at `.claude-plugin/plugin.json`) reaches it via the
  nested `./plugin/skills/` path; the Codex plugin roots at `plugin/` itself
  (manifest `plugin/.codex-plugin/plugin.json`, surfaced through
  `.agents/plugins/marketplace.json`) and reads `./skills/`. No generated mirror.
- The only per-host skill, `trace`, is a host-neutral dispatcher
  (`plugin/skills/trace/SKILL.md`) that points at `resources/claude.md` or
  `resources/codex.md` for the host-specific binding flow.

## Releasing

A release publishes one package — `@arielbk/trace` — to npm, and that's the
only thing distributed. The plugins aren't separate artifacts: the skills and
the `SessionStart` hook invoke the CLI through an **exact-pinned**
`npx @arielbk/trace@<version>` (never `@latest`), so a given commit always calls
a known CLI version. The catch is that those pins live in several files — every
`plugin/skills/*/SKILL.md`, the `trace` skill's `resources/codex.md`, and
`hooks/hooks.json` — and they must all move in lockstep with the published
version, or the plugin calls a CLI that doesn't exist yet.

That lockstep is what `release:trace` automates, so **don't hand-edit those
`npx @arielbk/trace@…` pins** — the release script rewrites them and then
verifies every one matches, failing the release on any drift. The pinned files
aren't hand-listed — the release script discovers them by scanning
`plugin/skills/**` and `hooks/` for the `npx @arielbk/trace@…` pin, so a new
skill or skill resource is picked up automatically.

One command does the whole thing — stamp every pin (plus `apps/cli/package.json`
and the Codex plugin manifest), build the web UI and the CLI, `npm pack`, and
publish:

```sh
# Always dry-run first — stamps, builds, packs, and runs `npm publish --dry-run`
corepack pnpm release:trace -- --bump patch --dry-run

# Real publish (drop --dry-run). Requires npm auth for the @arielbk scope.
corepack pnpm release:trace -- --bump patch
```

Pick the version with either `--bump patch|minor|major` (computed from the
current `apps/cli/package.json`) or `--version x.y.z` for an explicit one — not
both. A real publish needs write access to the `@arielbk` npm scope configured
in your `~/.npmrc`; published versions are immutable, so let the dry-run pass
before dropping the flag.
