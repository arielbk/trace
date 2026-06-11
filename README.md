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
   `/clear` — name the task. The agent reloads the state file, the docs, and only
   if needed the tail of the last session, then keeps going.

If you ever start real work in a session that _isn't_ tracked, Trace notices and
offers to bind it — so you don't have to remember to.

## The skills

Trace is a set of focused Claude Code skills. Each fires on one kind of intent, so
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
shared re-entry core that loads context the same way.

## What's underneath

- A bundled **`trace` CLI** the skills call — no global install, no `PATH` setup.
- A **SQLite store** at `~/.trace/trace.sqlite` recording tasks and the sessions
  bound to them.
- **Transcript adapters** that read agent session transcripts (Claude today,
  Codex too) so re-entry can surface the tail of a prior session on demand.
- A **`SessionStart` hook** that injects the one-line "no task is tracking this
  session" nudge.
- Per-task docs at `~/.trace/tasks/<slug>/docs/` — the known place re-entry looks.

## Setup

Trace installs as a Claude Code plugin. From inside Claude Code, add this repo as
a marketplace:

```sh
/plugin marketplace add arielbk/trace-v2
```

Then, as a separate command, install the plugin:

```sh
/plugin install trace@trace-v2
```

The plugin ships the CLI, the skills, and the `SessionStart` hook — no global CLI
link or manual settings edit required. To confirm the hook is firing, start a
fresh session and run:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/trace.js" session list --unassigned
```

The new session should appear.

## Status

Same-tool re-entry — work in Claude Code, clear, re-enter, keep going — is the
core loop and works today. Cross-tool re-entry is the next increment: the store,
transcript adapters, and re-entry manifest are already tool-agnostic (`trace
session tail` reads both Claude and Codex transcripts), so the remaining work is a
Codex-side entry point that lets a task worked in Claude be re-entered in Codex
and back.

## Development

This is a [Turborepo](https://turborepo.dev) monorepo (pnpm workspaces).

```sh
pnpm install        # install dependencies
pnpm test           # run the test suites
pnpm check-types    # typecheck all packages
```

- `apps/cli` — the `trace` CLI
- `packages/core` — the store, transcript adapters, and re-entry manifest
- `skills/` — the Claude Code skills, auto-discovered by the plugin
