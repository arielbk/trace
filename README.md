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

The marketplace source is the repo itself, so it ships the Codex `trace` skill;
the skill invokes the CLI via the same version-pinned `npx @arielbk/trace@<version>`.
Codex has no live session-start slot, so the skill captures sessions by backfill —
it runs `trace session scan --codex` before it binds or re-enters a task. Same
store, same manifest; just a different capture path.

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

## Status

Same-tool re-entry — work in an agent, clear, re-enter, keep going — is the core
loop and works today. Cross-tool re-entry rides the shared manifest: a task
worked in one agent can be re-entered from another. The agents supported right
now are **Claude Code** and **Codex**; more are a matter of adding adapters.

## Development

This is a [Turborepo](https://turborepo.dev) monorepo (pnpm workspaces). It
requires **Node 22+** and **pnpm 11**; invoke pnpm via `corepack` so you get the
pinned version regardless of any globally shimmed pnpm.

```sh
corepack pnpm install        # install dependencies
corepack pnpm -r test        # run the test suites (per-package)
corepack pnpm check-types    # typecheck all packages
```

- `apps/cli` — the `trace` CLI
- `packages/core` — the store, transcript adapters, and re-entry manifest
- `skills/` — the Claude Code skills, auto-discovered by the Claude plugin
- `codex/` — the Codex plugin: skills under `codex/skills/`, manifest at
  `codex/.codex-plugin/plugin.json`, surfaced through `.agents/plugins/marketplace.json`
