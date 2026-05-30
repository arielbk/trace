# trace

**Re-enter a task with zero re-explaining.**

You work on something in a Claude Code session — make decisions, write code,
build up context. The session ends. Days later you (or a fresh agent) come back
and have to reconstruct all of it from memory and scrollback.

trace removes that step. It captures each session against a task, lets you drop
decision docs into a known place, and gives a fresh agent a single command that
hands back the thread: the task, its decision docs, and pointers to prior
sessions — newest first. No pasting transcripts, no re-explaining.

The first verified experience is **same-tool** re-entry: work in Claude Code,
`/clear`, re-enter, and keep going. Cross-tool (Codex) re-entry is the next
increment — the architecture is already tool-agnostic, but the Codex entry
point is intentionally not wired yet.

## Setup

trace is a small CLI plus a Claude Code skill. Two one-time steps:

```sh
# 1. Make the `trace` command available on your PATH (run once, from the repo).
pnpm install
pnpm link --global

# 2. Wire trace into Claude Code (idempotent — safe to re-run).
trace init
```

`trace init` registers a `SessionStart` hook in your `~/.claude/settings.json`
so every new Claude Code session is recorded against the store, confirms the
`trace` skill is discoverable, and prints anything still manual. Running it a
second time is a no-op — it won't duplicate the hook.

To confirm the hook is firing, start a fresh Claude Code session, then:

```sh
trace session list --unassigned
```

The new session should appear.

## The hero loop (same-tool)

This is the loop trace exists for. Walk it once and the value is obvious.

**1. Start working on a task.** In a Claude Code session, tell Claude what
you're working on:

> We're working on the checkout flow.

The `trace` skill binds the current session to a task (creating it if it
doesn't exist) and reports a **task docs directory**:

```
checkout-session-id   claude   claude:checkout-session-id
taskDocsDir: ~/.trace/tasks/<taskId>/docs
```

**2. Capture decisions where re-entry can find them.** Anything you write into
that `taskDocsDir` — a decisions doc, a plan, a handoff note — is associated
with the task automatically. No registration step.

```
~/.trace/tasks/<taskId>/docs/decisions.md
```

**3. Clear and re-enter.** Run `/clear` (or come back tomorrow in a brand-new
session). Then tell the fresh agent:

> Re-enter the checkout flow.

The skill hands the agent a manifest — the task header, its decision docs, and
prior sessions ordered newest-first with the most recent flagged:

```
task:
  id: <taskId>
  title: Checkout flow
  projectRoot: /path/to/repo
docs:
- path: ~/.trace/tasks/<taskId>/docs/decisions.md
sessions:
- id: checkout-session-id
  tool: claude
  transcript: claude:checkout-session-id
  mostRecent: true
```

The fresh agent reads the decision docs first. Only if those don't cover the
current state does it pull the recent dialogue from the most-recent session:

```sh
trace session tail <session-id>
```

It never pastes raw transcripts, and never asks you to re-explain what the
manifest already carries. That's the whole point: the thread is picked up, not
reconstructed.

## What's next

- **Cross-tool re-entry (Codex).** The store, transcript adapters, and re-entry
  manifest are already tool-agnostic — `trace session tail` reads both Claude
  and Codex transcripts today. The remaining work is a Codex-side entry point
  (a session hook + skill wrapper) so a task worked in Claude can be re-entered
  in Codex and vice versa.

## Development

This is a [Turborepo](https://turborepo.dev) monorepo (pnpm workspaces).

```sh
pnpm install        # install dependencies
pnpm test           # run the test suites
pnpm check-types    # typecheck all packages
```

- `apps/cli` — the `trace` CLI
- `packages/core` — the store, transcript adapters, and re-entry manifest
- `.claude/skills/trace` — the Claude Code skill that drives the hero loop
