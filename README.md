<h1 align="center">Trace</h1>

<p align="center">
  <strong>Pick up any task exactly where you left off, in any agent, days later, without re-explaining it.</strong>
</p>

<p align="center">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-D97757?logo=anthropic&logoColor=white">
  <img alt="Codex" src="https://img.shields.io/badge/Codex-000000">
  <img alt="Cursor" src="https://img.shields.io/badge/Cursor-000000?logo=cursor&logoColor=white">
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

Install the CLI globally, then run setup once to wire up the agent tools you use.
The CLI, skills, and hooks are all managed by one persistent install — no plugin
marketplace, no per-repo config, no pinned `npx` commands.

### Install

```sh
npm install -g @arielbk/trace
# or
pnpm add -g @arielbk/trace
# or
bun install -g @arielbk/trace
```

### Wire up your agents

```sh
trace setup
```

Running `trace setup` with no flags auto-detects installed Codex and Cursor
roots and installs the six Trace skills into each. For Claude Code, pass
`--tool claude`:

```sh
trace setup --tool claude
```

You can run `trace setup` at any time to add new tools or reconcile existing
installs. It is idempotent: re-running it changes nothing when everything is
already current.

<details>
<summary>What this does</summary>

`trace setup` copies the six canonical Trace skills (`trace`, `trace-reenter`,
`trace-recall`, `trace-state`, `trace-doc-placement`, `trace-board`) into each
agent's user-level skills directory, registers Claude Code's `SessionStart`,
`SubagentStop`, and `Stop` hooks with the CLI's absolute path so hooks survive
across updates, and records each installed target in `~/.trace/integrations.json`
so `trace update` can reconcile them later.

</details>

### Update

```sh
trace update
```

Resolves the latest published version, reinstalls via your package manager, then
runs `trace setup` for each registered agent to reconcile skills and hooks.

### Target a specific tool or path

```sh
trace setup --tool codex
trace setup --tool cursor
trace setup --tool claude --target claude=/path/to/custom/config
```

### Remove

```sh
trace setup --remove
```

Removes only Trace-owned skills, hooks, and metadata. Unrelated agent
configuration is never touched.

### Migrating from the old plugin install

If you previously installed Trace via the Claude Code plugin marketplace or
`codex plugin`, run:

```sh
trace setup --tool claude    # or codex, cursor
```

Trace will detect the legacy plugin entry or pinned `npx` hook and print exact
remediation guidance before making any change. Follow the instructions (typically:
remove the old plugin, then re-run setup with `--yes`) and your configuration will
be on the CLI-first path.

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

### Encrypted sync keys

Task documents are encrypted before cloud sync. The first `trace login` for an
empty account generates a document encryption key and shows it once; save that
key somewhere secure. On another machine, `trace login` asks for the same key
and verifies it against your synced documents. Run `trace key show` on a
configured machine when you need to copy it.

If every copy of the key is lost, generate a fresh key during login and re-upload
from a machine that still has the plaintext task documents. Existing encrypted
cloud copies cannot be recovered without the old key.

## What it looks like

Open a task and the first thing you see is where you left off: a short summary,
the decisions you made, the next step, and any open questions. This is exactly
what a fresh session reloads on re-entry, so you start from a briefing instead of
a blank prompt.

![A task detail view leading with a "Where you left off" panel above the task's token totals](docs/screenshots/task-context.png)

Below it sits one timeline that doesn't care which tool did the work. Claude
sessions, Codex sessions, and the sub-agents they spin off all nest the same way,
interleaved with the docs written along the way.

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
now are **Claude Code**, **Codex**, and **Cursor** (both the GUI and the
`cursor-agent` CLI; macOS, pull-time capture, no live hook yet). More are a matter
of adding adapters.

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
