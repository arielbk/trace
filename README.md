<h1 align="center">Trace</h1>

<p align="center">
  <strong>Pick up any task exactly where you left off, in any agent, days later, without re-explaining it.</strong>
</p>

<p align="center">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=anthropic&logoColor=white">
  <img alt="Codex" src="https://img.shields.io/badge/Codex-000000">
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-000000?logo=cursor&logoColor=white">
  <img alt="GitHub Copilot CLI" src="https://img.shields.io/badge/GitHub_Copilot_CLI-000000?logo=github&logoColor=white">
</p>

You work something out with an agent, build up a head full of context, and the
session ends. Days later you (or a fresh agent with an empty memory) reconstruct
all of it from scrollback and guesswork. The mistake is treating the **session**
as the thing that ties your work together. It isn't: sessions are throwaway, the
**task** is the thread.

Trace makes that the default. It records each agent session against a task, gives
you a known place to drop plans and decision docs, and lets a brand-new session
reload the whole thread with one sentence:

> Re-enter the checkout flow.

The agent gets back the task, its docs, a distilled summary of where you left off,
and pointers to prior sessions. No pasting transcripts, no "remind me what we
decided." It's cheaper, too: re-entering a short summary spends a fraction of the
tokens you'd burn making a fresh agent re-derive everything from scrollback. And
Trace doesn't care which agent you use, so a task you start in one session you can
re-enter in another, even a different agent, all in the same store underneath.

## Setup

Install the agents you use. They share one SQLite store and one re-entry
manifest, so a task is visible from whichever session you re-enter on.

### Claude Code

From inside Claude Code, add this repo as a marketplace, then install the plugin:

```sh
/plugin marketplace add arielbk/trace
/plugin install trace@trace
/reload-plugins
```

<details>
<summary>What this does</summary>

The plugin wires up the skills and the hooks: `SessionStart` captures each
session live, and `Stop` keeps the bound task's `state.md` fresh — when a
turn ends with the task's docs ahead of the state file's prose, it sends the
still-warm agent back to update it (a fingerprint gate means ordinary chat
turns never trigger it). No global CLI link or manual settings edit; the
skills and hooks invoke the CLI on demand via a version-pinned
`npx @arielbk/trace@<version>`, so there's nothing to build or link. After
reloading, ask the agent _"Are we currently in a trace session?"_ and it
should confirm the session is being tracked.

</details>

### Codex

From your terminal, add this repo as a marketplace, then install the plugin:

```sh
codex plugin marketplace add arielbk/trace
codex plugin add trace@trace
```

<details>
<summary>What this does</summary>

Codex installs from the same canonical skills tree as Claude, so it ships the
full skill set (not just `trace`). Codex has no live session-start slot, so the
skill captures sessions by backfill: it runs `trace session scan --codex` before
it binds or re-enters a task. Same store, same manifest; just a different capture
path. The same asymmetry covers `state.md` freshness: with no live stop hook,
drift is reported in the re-entry manifest and repaired by the entering agent.

</details>

### Cursor

Cursor has no plugin marketplace but supports Agent Skills, so you install the
skills directly. From your project:

```sh
npx skills add arielbk/trace-v2/plugin/skills
```

<details>
<summary>What this does</summary>

That installs the same six trace skills the Claude and Codex plugins ship, from
the same canonical tree; Cursor's agent routes on the skill descriptions exactly
as the other hosts do. (The `/plugin/skills` subpath matters: it scopes the
install to the real skills.)

There's no session-start hook, so capture is **pull-time**: when a skill binds or
re-enters a task, trace resolves the session you're in from the directory the
command runs in. Both Cursor surfaces are covered: GUI composer sessions are read
from Cursor's local session store (`state.vscdb`), and `cursor-agent` (CLI) chats
from their transcript files under `~/.cursor/projects`. When both exist for a
directory, the one you touched most recently wins. `state.md` freshness is
pull-time too: drift is reported in the re-entry manifest and repaired by the
entering agent.

> Cursor does not record per-message token _spend_ in its local store, so the
> board shows a session's context-window usage instead of an input/output total.

</details>

### Copilot CLI

Install the Copilot plugin directly from GitHub:

```sh
copilot plugin install arielbk/trace:plugin
```

To develop the plugin from a local Trace checkout instead, run
`copilot plugin install ./plugin` from the repository root.

<details>
<summary>What this does</summary>

The plugin registers a Copilot session at `sessionStart`, prompts the agent to
consult Trace and bind or re-enter work, and checks the bound task's `state.md`
at `agentStop`. Trace identifies the live session through Copilot's lock files,
so run Trace commands from within the Copilot session.

> Copilot records an **output-only token** total in its transcript. The board
> does not show Copilot input or cache-token totals.

</details>

## How it works

It's a loop:

1. **Say what you're working on.** "We're working on the checkout flow." Trace
   binds the session to a task (creating it if needed) and tells you where the
   task's docs live.
2. **Drop docs where re-entry can find them.** Any spec, plan, or note you write
   into that task's docs directory is associated with the task automatically.
3. **Wrap up — or don't.** When you're done for the session, Trace distills it
   into the task's living state file, so the next agent reads a summary, not a
   transcript. And if you never wrap up, the state file keeps itself honest: on
   Claude a `Stop` hook has the still-warm agent write it the moment the docs
   move ahead of it, and on agents without a live hook the next re-entry
   detects the drift and repairs it before continuing.
4. **Come back and re-enter.** In a fresh session (tomorrow, next week, a clean
   `/clear`, or a different agent entirely) name the task. The agent reloads the
   state file, the docs, and only if needed the tail of the last session, then
   keeps going.

If you ever start real work in a session that _isn't_ tracked, Trace notices and
offers to bind it, so you don't have to remember to.

## What it looks like

Open a task and the first thing you see is where you left off: a short summary,
the decisions you made, the next step, and any open questions. This is exactly
what a fresh session reloads on re-entry, so you start from a briefing instead of
a blank prompt.

![A task detail view leading with a "Where you left off" panel above the task's token totals](docs/screenshots/task-context.png)

Below it sits one timeline that doesn't care which tool did the work. Claude,
Codex, Cursor, and Copilot sessions all appear alongside the docs written along
the way.

![The same task's activity timeline: a Claude session with a nested code-reviewer sub-agent, a Codex session, and docs on one spine](docs/screenshots/task-detail.png)

## The skills

Trace is a **store**; the **skills** are the behaviour. Trace records sessions
against tasks and surfaces the right context back on re-entry. That's its whole
job: _remember, and hand back._ Everything else (scoping, spec-writing, distilling
a session into a handoff) lives in skills, which are separate, swappable, and
yours to keep or replace.

| Skill                   | Fires when you…                                       | What it does                                                                                                 |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **trace**               | say you're working on / scoping / defining something  | binds the session to a task (creating it if absent); nudges you when an untracked session is doing real work |
| **trace-reenter**       | name a task by its exact slug or title                | reloads that task's full context from its re-entry manifest                                                  |
| **trace-recall**        | gesture vaguely at past work ("that archiving thing") | figures out _which_ task you mean, then re-enters it                                                         |
| **trace-state**         | wrap up, hand off, or Trace reports state drift       | distills the session into the task's living `state.md`; also runs when Trace detects the docs moved ahead    |
| **trace-doc-placement** | write a spec, PRD, plan, or note                      | lands the file in the current task's docs directory                                                          |
| **trace-board**         | ask to open the board                                 | starts the local web UI for browsing tasks                                                                   |

## Status

Same-tool re-entry (work in an agent, clear, re-enter, keep going) is the core
loop and works today. Cross-tool re-entry rides the shared manifest: a task
worked in one agent can be re-entered from another. The agents supported right
now are **Claude Code**, **Codex**, **Cursor** (both the GUI and the
`cursor-agent` CLI; macOS, pull-time capture, no live hook yet), and **GitHub
Copilot CLI** (macOS, live hooks, output-only token totals). More are a matter of
adding adapters.

<details>
<summary>Why "meta-harness"?</summary>

There's a name for the layer this lives in: a _meta-harness_, the layer above the
harness itself, a harness of harnesses. Each coding agent (Claude Code, Codex, and
the rest) is a silo, with its own context and its own runtime, none of it carrying
over when you switch tools or start a new session. A meta-harness lifts your work
out of that silo. (The term comes from Databricks'
[Omnigent](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents):
Omnigent is a meta-harness for the _session_, the agents running right now; Trace
is a meta-harness for the _task_, the same work carried across sessions, tools, and
days.)

</details>

---

Working on Trace itself, or wiring it into your own tooling? See
[CONTRIBUTING.md](./CONTRIBUTING.md) for what's underneath, registering spawned
children, development, and releasing.
